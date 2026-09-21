/**
 * Testes do service Asaas (Fase A — SPEC billing-asaas).
 * fetch é mockado globalmente — NUNCA chamar o sandbox real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createCustomer,
	createSubscription,
	loadAsaasConfig,
} from "../../src/services/asaas.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
	fetchMock.mockReset();
});

describe("loadAsaasConfig", () => {
	it("configured=false sem ASAAS_API_KEY", () => {
		expect(loadAsaasConfig({})).toBeNull();
	});

	it("configured=false com chave vazia/whitespace", () => {
		expect(loadAsaasConfig({ ASAAS_API_KEY: "   " })).toBeNull();
	});

	it("configura com defaults (sandbox) e plano em centavos", () => {
		const cfg = loadAsaasConfig({
			ASAAS_API_KEY: "key-123",
			ASAAS_PLAN_VALUE: "2990",
		});
		expect(cfg).toEqual({
			apiKey: "key-123",
			baseUrl: "https://api-sandbox.asaas.com",
			planValueCents: 2990,
		});
	});

	it("respeita ASAAS_BASE_URL custom e remove barra final", () => {
		const cfg = loadAsaasConfig({
			ASAAS_API_KEY: "k",
			ASAAS_BASE_URL: "https://api.asaas.com/",
		});
		expect(cfg?.baseUrl).toBe("https://api.asaas.com");
	});

	it("plano inválido/ausente vira 0 (rota responde 503)", () => {
		const cfg = loadAsaasConfig({ ASAAS_API_KEY: "k" });
		expect(cfg?.planValueCents).toBe(0);
		const cfg2 = loadAsaasConfig({
			ASAAS_API_KEY: "k",
			ASAAS_PLAN_VALUE: "abc",
		});
		expect(cfg2?.planValueCents).toBe(0);
	});
});

describe("createCustomer", () => {
	it("POST /v3/customers com access_token e payload mínimo", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ id: "cus_1" }), { status: 200 }),
		);
		const cfg = loadAsaasConfig({ ASAAS_API_KEY: "k" });
		if (cfg === null) throw new Error("config deveria estar ativa");

		const customer = await createCustomer(cfg, {
			name: "Studio X",
			email: "x@y.com",
			externalReference: "biz-uuid",
		});

		expect(customer).toEqual({ id: "cus_1" });
		const call0 = fetchMock.mock.calls[0];
		if (!call0) throw new Error("fetch não chamado");
		const [url, init] = call0;
		expect(url).toBe("https://api-sandbox.asaas.com/v3/customers");
		expect((init.headers as Record<string, string>).access_token).toBe("k");
		const body = JSON.parse(init.body as string);
		expect(body).toEqual({
			name: "Studio X",
			email: "x@y.com",
			externalReference: "biz-uuid",
		});
	});

	it("lança com detalhe do erro quando o Asaas responde 4xx/5xx", async () => {
		fetchMock.mockResolvedValue(
			new Response('{"errors":[{"description":"bad"}]}', { status: 400 }),
		);
		const cfg = loadAsaasConfig({ ASAAS_API_KEY: "k" });
		if (cfg === null) throw new Error("config deveria estar ativa");
		await expect(
			createCustomer(cfg, {
				name: "x",
				email: "x@y.com",
				externalReference: "r",
			}),
		).rejects.toThrow("Asaas 400");
	});

	it("erro do Asaas com body ilegível não explode no catch do text()", async () => {
		// Response cujo .text() rejeita → cai no catch(() => "") do service
		fetchMock.mockResolvedValue({
			ok: false,
			status: 500,
			text: () => Promise.reject(new Error("socket quebrado")),
		});
		const cfg = loadAsaasConfig({ ASAAS_API_KEY: "k" });
		if (cfg === null) throw new Error("config deveria estar ativa");
		await expect(
			createSubscription(cfg, {
				customerId: "cus_1",
				nextDueDate: "2026-09-21",
			}),
		).rejects.toThrow("Asaas 500");
	});
});

describe("createSubscription", () => {
	it("POST /v3/subscriptions MONTHLY com value em reais", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({ id: "sub_1", invoiceUrl: "https://pay/x" }),
				{ status: 200 },
			),
		);
		const cfg = loadAsaasConfig({
			ASAAS_API_KEY: "k",
			ASAAS_PLAN_VALUE: "2990",
		});
		if (cfg === null) throw new Error("config deveria estar ativa");

		const sub = await createSubscription(cfg, {
			customerId: "cus_1",
			nextDueDate: "2026-09-21",
		});

		expect(sub.id).toBe("sub_1");
		const call0 = fetchMock.mock.calls[0];
		if (!call0) throw new Error("fetch não chamado");
		const [, init] = call0;
		const body = JSON.parse(init.body as string);
		expect(body).toMatchObject({
			customer: "cus_1",
			billingType: "UNDEFINED",
			value: 29.9,
			cycle: "MONTHLY",
			nextDueDate: "2026-09-21",
		});
	});
});
