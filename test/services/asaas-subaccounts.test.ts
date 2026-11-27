/**
 * Service das subcontas Asaas (F5). fetch mockado — NUNCA chama o Asaas real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AsaasError,
	cancelCharge,
	createCharge,
	createSubaccount,
	ensureCustomer,
	loadSubaccountConfig,
	SUBACCOUNT_EVENTS,
	subaccountStatus,
} from "../../src/services/asaas-subaccounts.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());

const ENV = {
	ASAAS_SUBACCOUNTS_ENABLED: "1",
	ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3/",
	ASAAS_SUBACCOUNTS_API_KEY: "root-key",
	ASAAS_SUBACCOUNT_ENC_KEY: "enc",
	ASAAS_SUBACCOUNT_WEBHOOK_TOKEN: "tok",
	ASAAS_SUBACCOUNT_WEBHOOK_URL: "https://api.agenva.test/",
};
const loaded = loadSubaccountConfig(ENV);
if (!loaded) throw new Error("config de teste incompleta");
const cfg = loaded;
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

describe("loadSubaccountConfig", () => {
	it("normaliza URLs; desligado ou incompleto → null", () => {
		expect(cfg.baseUrl).toBe("https://api-sandbox.asaas.com");
		expect(cfg.webhookUrl).toBe("https://api.agenva.test");
		expect(
			loadSubaccountConfig({ ...ENV, ASAAS_SUBACCOUNTS_ENABLED: "0" }),
		).toBeNull();
		expect(
			loadSubaccountConfig({ ...ENV, ASAAS_SUBACCOUNT_ENC_KEY: " " }),
		).toBeNull();
		const { ASAAS_BASE_URL: _b, ...noBase } = ENV;
		expect(loadSubaccountConfig(noBase)?.baseUrl).toBe(
			"https://api-sandbox.asaas.com",
		);
	});
});

describe("RF-F13 — chamadas ao Asaas", () => {
	it("cria subconta com a chave raiz e o webhook do negócio", async () => {
		fetchMock.mockResolvedValueOnce(
			json({ id: "acc1", walletId: "w1", apiKey: "sub-key", extra: 1 }),
		);
		const r = await createSubaccount(cfg, "biz-1", {
			name: "Ana",
			email: "ana@t.dev",
			cpfCnpj: "12345678909",
			birthDate: "1990-01-01",
			mobilePhone: "11999999999",
			incomeValue: 5000,
			postalCode: "17010000",
			address: "Rua A",
			addressNumber: "1",
			province: "Centro",
		});
		expect(r).toEqual({ id: "acc1", walletId: "w1", apiKey: "sub-key" });
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api-sandbox.asaas.com/v3/accounts");
		expect((init.headers as Record<string, string>).access_token).toBe(
			"root-key",
		);
		const body = JSON.parse(init.body as string);
		expect(body.webhooks[0]).toMatchObject({
			url: "https://api.agenva.test/webhooks/asaas/subaccounts/biz-1",
			authToken: "tok",
			events: [...SUBACCOUNT_EVENTS],
		});
	});

	it("status, cliente (achado e criado), cobrança e cancelamento com a chave da subconta", async () => {
		fetchMock
			.mockResolvedValueOnce(json({ general: "APPROVED" }))
			.mockResolvedValueOnce(json({}))
			.mockResolvedValueOnce(json({ data: [{ id: "cus-old" }] }))
			.mockResolvedValueOnce(json({ data: [] }))
			.mockResolvedValueOnce(json({ id: "cus-new" }))
			.mockResolvedValueOnce(json({ id: "pay1", invoiceUrl: "https://i/1" }))
			.mockResolvedValueOnce(json({ id: "pay2" }))
			.mockResolvedValueOnce(json({ deleted: true }));
		expect(await subaccountStatus(cfg, "sk")).toBe("APPROVED");
		expect(await subaccountStatus(cfg, "sk")).toBe("PENDING");
		const c = { name: "Cli", cpfCnpj: "1", externalReference: "c 1" };
		expect(await ensureCustomer(cfg, "sk", c)).toBe("cus-old");
		expect(await ensureCustomer(cfg, "sk", c)).toBe("cus-new");
		const p = {
			customer: "cus-new",
			valueCents: 7050,
			dueDate: "2026-12-01",
			description: "Escova",
			externalReference: "a1",
		};
		expect(await createCharge(cfg, "sk", p)).toEqual({
			id: "pay1",
			invoiceUrl: "https://i/1",
		});
		expect((await createCharge(cfg, "sk", p)).invoiceUrl).toBeNull();
		await cancelCharge(cfg, "sk", "pay1");

		const calls = fetchMock.mock.calls as [string, RequestInit][];
		expect(
			calls.every(
				([, i]) => (i.headers as Record<string, string>).access_token === "sk",
			),
		).toBe(true);
		expect(calls[2]?.[0]).toContain("/v3/customers?externalReference=c%201");
		expect(JSON.parse(calls[5]?.[1].body as string)).toMatchObject({
			billingType: "UNDEFINED",
			value: 70.5,
		});
		expect(calls[7]?.[0]).toBe(
			"https://api-sandbox.asaas.com/v3/payments/pay1",
		);
		expect(calls[7]?.[1].method).toBe("DELETE");
	});

	it.each([
		[
			json({ errors: [{ description: "CPF inválido" }] }, 400),
			400,
			"CPF inválido",
		],
		[json({ message: "Contas PF não podem" }, 403), 403, "Contas PF não podem"],
		[
			new Response("<html>", { status: 502 }),
			502,
			"Não foi possível falar com o Asaas agora. Tente de novo.",
		],
	])("erro do Asaas vira AsaasError (%#)", async (resp, status, message) => {
		fetchMock.mockResolvedValueOnce(resp);
		const err = await subaccountStatus(cfg, "sk").catch((e) => e);
		expect(err).toBeInstanceOf(AsaasError);
		expect(err).toMatchObject({ status, message });
	});
});
