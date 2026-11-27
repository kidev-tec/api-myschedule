/**
 * Integração REAL (banco) com Asaas SIMULADO: recebimento online por subconta
 * (módulo de finanças F5 — RF-F13). fetch é trocado por um Asaas falso.
 */

import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({
	getApps: vi.fn(() => [{} as never]),
}));
vi.mock("../../src/services/fcm.js", () => ({
	sendToUser: vi.fn(async () => undefined),
}));

import { createApp } from "../../src/app.js";
import { methodOf } from "../../src/routes/asaas-subaccount-webhook.js";
import { mapAccountStatus } from "../../src/routes/finance-online.js";
import {
	cleanup,
	errorOf,
	type FinBase,
	jsonReq,
	setupBusiness,
} from "../helpers/finance-fixture.js";

// ---- Asaas falso -----------------------------------------------------------
type Call = { method: string; path: string; key: string; body: unknown };
const asaas = {
	calls: [] as Call[],
	seq: 0,
	general: "PENDING",
	failNext: null as null | { status: number; body: unknown },
};
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
	const url = new URL(String(input));
	if (url.host !== "asaas.test") return realFetch(input, init);
	const method = init?.method ?? "GET";
	const key =
		((init?.headers ?? {}) as Record<string, string>).access_token ?? "";
	const body = init?.body ? JSON.parse(String(init.body)) : undefined;
	asaas.calls.push({ method, path: url.pathname + url.search, key, body });
	const res = (b: unknown, status = 200) =>
		new Response(JSON.stringify(b), { status });
	if (asaas.failNext) {
		const f = asaas.failNext;
		asaas.failNext = null;
		return res(f.body, f.status);
	}
	const n = ++asaas.seq;
	if (method === "POST" && url.pathname === "/v3/accounts") {
		return res({ id: `acc_${n}`, walletId: `w_${n}`, apiKey: `subkey_${n}` });
	}
	if (url.pathname === "/v3/myAccount/status")
		return res({ general: asaas.general });
	if (method === "GET" && url.pathname === "/v3/customers")
		return res({ data: [] });
	if (method === "POST" && url.pathname === "/v3/customers")
		return res({ id: `cus_${n}` });
	if (method === "POST" && url.pathname === "/v3/payments") {
		return res({ id: `pay_${n}`, invoiceUrl: `https://asaas.test/i/${n}` });
	}
	if (method === "DELETE") return res({ deleted: true });
	return res({ errors: [{ description: "rota falsa" }] }, 404);
});

const ENV = {
	ASAAS_SUBACCOUNTS_ENABLED: "1",
	ASAAS_BASE_URL: "https://asaas.test/v3",
	ASAAS_SUBACCOUNTS_API_KEY: "root-key",
	ASAAS_SUBACCOUNT_ENC_KEY: "chave-de-cifra-de-teste",
	ASAAS_SUBACCOUNT_WEBHOOK_TOKEN: "token-do-webhook-de-teste-0123456789",
	ASAAS_SUBACCOUNT_WEBHOOK_URL: "https://api.agenva.test",
};
const setEnv = (on: boolean) => {
	for (const [k, v] of Object.entries(ENV)) {
		if (on) process.env[k] = v;
		else delete process.env[k];
	}
};

// ---- app/banco -------------------------------------------------------------
const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";
const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});
const PREFIX = "FinOnline";
const known = new Set<string>();
verifyMock.mockImplementation(async (token: string) => {
	if (!known.has(token)) throw new Error("invalid");
	return { uid: token, email: `${token}@t.com`, name: "Pro Online" };
});
const setup = () => setupBusiness(app, sql, known, PREFIX);
const req = (b: FinBase, method: string, path: string, body?: unknown) =>
	jsonReq(app, b.h, method, path, body);

const ACTIVATE = {
	cpf_cnpj: "123.456.789-09",
	birth_date: "1990-05-10",
	mobile_phone: "(11) 98765-4321",
	income_cents: 500000,
	postal_code: "17010-000",
	address: "Rua A",
	address_number: "10",
	province: "Centro",
};

async function approved(b: FinBase) {
	expect(
		(await req(b, "POST", "/v1/finance/online/account", ACTIVATE)).status,
	).toBe(201);
	await sql`UPDATE businesses SET asaas_sub_status = 'approved' WHERE id = ${b.businessId}`;
	await sql`UPDATE clients SET cpf = '98765432100' WHERE id = ${b.clientId}`;
}

let slot = 0;
async function appt(
	b: FinBase,
	price = 10000,
	daysAhead = 3,
	status = "confirmed",
) {
	const start = new Date(Date.now() + daysAhead * 864e5 + slot++ * 3600_000);
	const [a] = await sql<{ id: string }[]>`
    INSERT INTO appointments (business_id, client_id, service_id, user_id,
      starts_at, ends_at, status, price_cents)
    VALUES (${b.businessId}, ${b.clientId}, ${b.serviceId}, ${b.userId}, ${start},
      ${new Date(start.getTime() + 1800_000)}, ${status}, ${price})
    RETURNING id`;
	if (!a) throw new Error("agendamento");
	return a.id;
}

type Charge = {
	id: string;
	amount_cents: number;
	status: string;
	invoice_url: string | null;
	due_date: string;
};
async function charge(b: FinBase, body: Record<string, unknown>) {
	const r = await req(b, "POST", "/v1/finance/charges", body);
	return {
		r,
		charge:
			r.status === 201 ? ((await r.json()) as { charge: Charge }).charge : null,
	};
}

function hook(
	businessId: string,
	body: unknown,
	token = ENV.ASAAS_SUBACCOUNT_WEBHOOK_TOKEN,
) {
	return app.request(`/webhooks/asaas/subaccounts/${businessId}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"asaas-access-token": token,
		},
		body: JSON.stringify(body),
	});
}
const paymentIdOf = async (chargeId: string) =>
	(
		await sql<
			{ p: string }[]
		>`SELECT asaas_payment_id AS p FROM charges WHERE id = ${chargeId}`
	)[0]?.p as string;

beforeEach(() => {
	setEnv(true);
	asaas.calls = [];
	asaas.general = "PENDING";
	asaas.failNext = null;
});

afterAll(async () => {
	setEnv(false);
	const biz = sql`SELECT id FROM businesses WHERE name LIKE ${`${PREFIX} %`}`;
	await sql`DELETE FROM charges WHERE business_id IN (${biz})`;
	await cleanup(sql, PREFIX);
});

describe("RF-F13 — ativar recebimento online", () => {
	it("desligado: GET avisa indisponível; POST 503", async () => {
		const b = await setup();
		setEnv(false);
		expect(
			await (await req(b, "GET", "/v1/finance/online/account")).json(),
		).toEqual({
			available: false,
			status: "none",
		});
		const r = await req(b, "POST", "/v1/finance/online/account", ACTIVATE);
		expect(r.status).toBe(503);
		expect(await errorOf(r)).toBe(
			"Recebimento online ainda não está disponível",
		);
	});

	it("cria a subconta com a chave raiz, guarda a chave CIFRADA e fica pendente", async () => {
		const b = await setup();
		const r = await req(b, "POST", "/v1/finance/online/account", ACTIVATE);
		expect(r.status).toBe(201);
		expect(await r.json()).toEqual({ available: true, status: "pending" });
		const call = asaas.calls[0] as Call;
		expect(call).toMatchObject({
			method: "POST",
			path: "/v3/accounts",
			key: "root-key",
		});
		expect(call.body).toMatchObject({
			cpfCnpj: "12345678909",
			birthDate: "1990-05-10",
			mobilePhone: "11987654321",
			incomeValue: 5000,
			postalCode: "17010000",
		});
		// sem nome no pedido: usa o nome do usuário
		expect((call.body as { name: string }).name).toMatch(/^FinOnline /);
		expect((call.body as { companyType?: string }).companyType).toBeUndefined();
		const [row] = await sql<{ enc: string; status: string; wallet: string }[]>`
      SELECT asaas_sub_api_key_enc AS enc, asaas_sub_status AS status,
             asaas_sub_wallet_id AS wallet
      FROM businesses WHERE id = ${b.businessId}`;
		expect(row?.status).toBe("pending");
		expect(row?.wallet).toMatch(/^w_/);
		expect(row?.enc).not.toContain("subkey");

		const again = await req(b, "POST", "/v1/finance/online/account", ACTIVATE);
		expect(again.status).toBe(409);
		expect(await errorOf(again)).toBe("O recebimento online já foi ativado");
	});

	it("CNPJ pede tipo de empresa; validações em PT-BR", async () => {
		const b = await setup();
		for (const [body, msg] of [
			[{ ...ACTIVATE, cpf_cnpj: "123" }, "CPF ou CNPJ inválido"],
			[{ ...ACTIVATE, birth_date: undefined }, "Informe a data de nascimento"],
			[
				{ ...ACTIVATE, cpf_cnpj: "11222333000181" },
				"Informe o tipo de empresa",
			],
			[{ ...ACTIVATE, mobile_phone: "123" }, "Celular inválido"],
			[{ ...ACTIVATE, postal_code: "1" }, "CEP inválido"],
			[{ ...ACTIVATE, income_cents: 0 }, "Faturamento mensal inválido"],
		] as const) {
			const r = await req(b, "POST", "/v1/finance/online/account", body);
			expect(r.status).toBe(400);
			expect(await errorOf(r)).toBe(msg);
		}
		const broken = await app.request("/v1/finance/online/account", {
			method: "POST",
			headers: { "content-type": "application/json", ...b.h },
			body: "{",
		});
		expect(broken.status).toBe(400);

		const pj = await req(b, "POST", "/v1/finance/online/account", {
			...ACTIVATE,
			cpf_cnpj: "11.222.333/0001-81",
			birth_date: undefined,
			company_type: "MEI",
			name: "Studio Ana",
		});
		expect(pj.status).toBe(201);
		expect(asaas.calls.at(-1)?.body).toMatchObject({
			companyType: "MEI",
			name: "Studio Ana",
		});
	});

	it("erro do Asaas: validação vira 422 com a mensagem dele; outro vira 502", async () => {
		const b = await setup();
		asaas.failNext = {
			status: 400,
			body: { errors: [{ description: "CPF já cadastrado" }] },
		};
		const r1 = await req(b, "POST", "/v1/finance/online/account", ACTIVATE);
		expect(r1.status).toBe(422);
		expect(await errorOf(r1)).toBe("CPF já cadastrado");
		asaas.failNext = { status: 403, body: { message: "Conta PF" } };
		const r2 = await req(b, "POST", "/v1/finance/online/account", ACTIVATE);
		expect(r2.status).toBe(502);
		expect(await errorOf(r2)).toContain("Conta PF");
	});

	it("GET pendente consulta o Asaas com a chave da subconta e atualiza", async () => {
		const b = await setup();
		await req(b, "POST", "/v1/finance/online/account", ACTIVATE);
		asaas.calls = [];
		expect(
			(
				(await (await req(b, "GET", "/v1/finance/online/account")).json()) as {
					status: string;
				}
			).status,
		).toBe("pending");
		asaas.general = "APPROVED";
		expect(
			(
				(await (await req(b, "GET", "/v1/finance/online/account")).json()) as {
					status: string;
				}
			).status,
		).toBe("approved");
		expect(asaas.calls.map((c) => c.path)).toEqual([
			"/v3/myAccount/status",
			"/v3/myAccount/status",
		]);
		expect(asaas.calls[0]?.key).toMatch(/^subkey_/);
		// aprovado: não consulta mais
		asaas.calls = [];
		await req(b, "GET", "/v1/finance/online/account");
		expect(asaas.calls).toEqual([]);
	});

	it("GET com o Asaas fora do ar mantém a situação gravada", async () => {
		const b = await setup();
		await req(b, "POST", "/v1/finance/online/account", ACTIVATE);
		asaas.failNext = { status: 500, body: {} };
		const r = await req(b, "GET", "/v1/finance/online/account");
		expect(((await r.json()) as { status: string }).status).toBe("pending");
	});

	it("mapAccountStatus", () => {
		expect(mapAccountStatus("APPROVED")).toBe("approved");
		expect(mapAccountStatus("REJECTED")).toBe("rejected");
		expect(mapAccountStatus("AWAITING_ACTION_AUTHORIZATION")).toBe("pending");
	});
});

describe("RF-F13 — cobrança por link", () => {
	it("cobra o saldo, com vencimento no dia do atendimento e a chave da subconta", async () => {
		const b = await setup();
		await approved(b);
		const a = await appt(b, 10000, 3);
		await sql`
      INSERT INTO transactions (business_id, type, amount_cents, category, appointment_id, payment_method)
      VALUES (${b.businessId}, 'income', 3000, 'atendimento', ${a}, 'pix')`;
		asaas.calls = [];
		const { r, charge: ch } = await charge(b, { appointment_id: a });
		expect(r.status).toBe(201);
		expect(ch).toMatchObject({ amount_cents: 7000, status: "pending" });
		expect(ch?.invoice_url).toMatch(/^https:\/\/asaas\.test\/i\//);
		const [day] = await sql<{ d: string }[]>`
      SELECT to_char(starts_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d
      FROM appointments WHERE id = ${a}`;
		expect(ch?.due_date).toBe(day?.d);
		expect(asaas.calls.map((c) => [c.method, c.path.split("?")[0]])).toEqual([
			["GET", "/v3/customers"],
			["POST", "/v3/customers"],
			["POST", "/v3/payments"],
		]);
		expect(asaas.calls.every((c) => c.key.startsWith("subkey_"))).toBe(true);
		expect(asaas.calls[1]?.body).toMatchObject({
			cpfCnpj: "98765432100",
			name: "Ana",
		});
		expect(asaas.calls[2]?.body).toMatchObject({
			billingType: "UNDEFINED",
			value: 70,
			externalReference: a,
		});

		// saldo todo em cobrança aberta → nova cobrança recusada
		const again = await charge(b, { appointment_id: a });
		expect(again.r.status).toBe(422);
		expect(await errorOf(again.r)).toBe(
			"Já existe cobrança em aberto para todo o saldo deste agendamento",
		);

		const list = await req(b, "GET", `/v1/finance/charges?appointment_id=${a}`);
		expect(((await list.json()) as { charges: Charge[] }).charges).toHaveLength(
			1,
		);
	});

	it("cobrar só o sinal; acima do saldo 422; atendimento passado vence hoje", async () => {
		const b = await setup();
		await approved(b);
		const a = await appt(b, 10000, 2);
		const s = await charge(b, { appointment_id: a, amount_cents: 3000 });
		expect(s.charge?.amount_cents).toBe(3000);
		const over = await charge(b, { appointment_id: a, amount_cents: 7001 });
		expect(over.r.status).toBe(422);
		expect(await errorOf(over.r)).toBe(
			"Valor maior que o saldo a cobrar (R$ 70,00)",
		);

		const past = await appt(b, 5000, -2, "done");
		const p = await charge(b, { appointment_id: past });
		const [today] = await sql<{ d: string }[]>`
      SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d`;
		expect(p.charge?.due_date).toBe(today?.d);
		const other = await appt(b, 5000, -3, "done");
		const pastDue = await charge(b, {
			appointment_id: other,
			due_date: "2020-01-01",
		});
		expect(pastDue.r.status).toBe(422);
		expect(await errorOf(pastDue.r)).toBe(
			"O vencimento não pode ser no passado",
		);
	});

	it("regras: não ativado, pendente, sem CPF, sem saldo, cancelado, outro negócio, desligado", async () => {
		const b = await setup();
		const a = await appt(b);
		const r0 = await charge(b, { appointment_id: a });
		expect(r0.r.status).toBe(409);
		expect(await errorOf(r0.r)).toBe("Ative o recebimento online primeiro");
		await req(b, "POST", "/v1/finance/online/account", ACTIVATE);
		const r1 = await charge(b, { appointment_id: a });
		expect(await errorOf(r1.r)).toBe(
			"Seu recebimento online ainda não foi aprovado pelo Asaas",
		);

		await sql`UPDATE businesses SET asaas_sub_status = 'approved' WHERE id = ${b.businessId}`;
		const r2 = await charge(b, { appointment_id: a });
		expect(r2.r.status).toBe(422);
		expect(await errorOf(r2.r)).toBe(
			"Cadastre o CPF do cliente para cobrar online",
		);

		await sql`UPDATE clients SET cpf = '98765432100' WHERE id = ${b.clientId}`;
		const free = await appt(b, 0);
		expect(await errorOf((await charge(b, { appointment_id: free })).r)).toBe(
			"Este agendamento não tem saldo a cobrar",
		);
		const canceled = await appt(b, 1000, 4, "canceled");
		expect(
			await errorOf((await charge(b, { appointment_id: canceled })).r),
		).toBe("Agendamento cancelado não pode ser cobrado");
		const other = await setup();
		const foreign = await appt(other);
		expect((await charge(b, { appointment_id: foreign })).r.status).toBe(404);
		expect((await charge(b, { appointment_id: "x" })).r.status).toBe(400);
		expect(
			await errorOf(
				(await charge(b, { appointment_id: a, amount_cents: 100 })).r,
			),
		).toBe("Valor mínimo para cobrar pelo link: R$ 5,00");
		const broken = await app.request("/v1/finance/charges", {
			method: "POST",
			headers: { "content-type": "application/json", ...b.h },
			body: "{",
		});
		expect(broken.status).toBe(400);

		asaas.failNext = {
			status: 400,
			body: { errors: [{ description: "CPF do cliente inválido" }] },
		};
		const r3 = await charge(b, { appointment_id: a });
		expect(r3.r.status).toBe(422);
		expect(await errorOf(r3.r)).toBe("CPF do cliente inválido");

		setEnv(false);
		expect((await charge(b, { appointment_id: a })).r.status).toBe(503);
		expect((await req(b, "DELETE", "/v1/finance/charges/x")).status).toBe(503);
	});

	it("cancelar: só em aberto; isolamento; erro do Asaas", async () => {
		const b = await setup();
		const other = await setup();
		await approved(b);
		const a = await appt(b, 9000);
		const { charge: ch } = await charge(b, { appointment_id: a });
		const id = ch?.id as string;
		expect(
			(await req(other, "DELETE", `/v1/finance/charges/${id}`)).status,
		).toBe(404);
		expect((await req(b, "DELETE", "/v1/finance/charges/abc")).status).toBe(
			400,
		);

		asaas.failNext = { status: 500, body: {} };
		expect((await req(b, "DELETE", `/v1/finance/charges/${id}`)).status).toBe(
			502,
		);

		const del = await req(b, "DELETE", `/v1/finance/charges/${id}`);
		expect(del.status).toBe(200);
		expect(((await del.json()) as { charge: Charge }).charge.status).toBe(
			"canceled",
		);
		expect(asaas.calls.at(-1)?.method).toBe("DELETE");
		const again = await req(b, "DELETE", `/v1/finance/charges/${id}`);
		expect(again.status).toBe(409);
		// cancelada libera o saldo para nova cobrança
		expect((await charge(b, { appointment_id: a })).r.status).toBe(201);
		expect(
			(await req(b, "GET", "/v1/finance/charges?appointment_id=x")).status,
		).toBe(400);
		expect((await req(b, "GET", "/v1/finance/charges")).status).toBe(400);
	});
});

describe("RF-F13 — webhook das subcontas", () => {
	it("pagamento confirmado lança o recebimento UMA vez (sinal pelo Pix)", async () => {
		const b = await setup();
		await approved(b);
		const a = await appt(b, 10000, 5);
		const { charge: ch } = await charge(b, {
			appointment_id: a,
			amount_cents: 4000,
		});
		const pid = await paymentIdOf(ch?.id as string);
		const ev = {
			event: "PAYMENT_RECEIVED",
			payment: { id: pid, billingType: "PIX" },
		};
		expect(await (await hook(b.businessId, ev)).json()).toEqual({
			ok: true,
			status: "paid",
		});
		expect(await (await hook(b.businessId, ev)).json()).toEqual({
			ok: true,
			duplicate: true,
		});

		const txs = await sql<
			{ kind: string; method: string; amount: number; notes: string }[]
		>`
      SELECT kind, payment_method AS method, amount_cents AS amount, notes
      FROM transactions WHERE appointment_id = ${a}`;
		expect(txs).toEqual([
			{
				kind: "deposit",
				method: "pix",
				amount: 4000,
				notes: "Pago pelo link (Asaas)",
			},
		]);
		const [c] = await sql<{ status: string; tx: string | null }[]>`
      SELECT status, transaction_id AS tx FROM charges WHERE id = ${ch?.id as string}`;
		expect(c?.status).toBe("paid");
		expect(c?.tx).not.toBeNull();
		// atraso/cancelamento depois de pago não desfaz
		await hook(b.businessId, {
			event: "PAYMENT_OVERDUE",
			payment: { id: pid },
		});
		expect(
			(await sql`SELECT status FROM charges WHERE id = ${ch?.id as string}`)[0]
				?.status,
		).toBe("paid");

		// estorno no Asaas estorna o lançamento
		await hook(b.businessId, {
			event: "PAYMENT_REFUNDED",
			payment: { id: pid },
		});
		const [after] = await sql<{ status: string; voided: boolean }[]>`
      SELECT c.status, t.voided_at IS NOT NULL AS voided
      FROM charges c JOIN transactions t ON t.id = c.transaction_id
      WHERE c.id = ${ch?.id as string}`;
		expect(after).toEqual({ status: "refunded", voided: true });
	});

	it("cartão em 3x após o atendimento = pagamento; atraso e cancelamento", async () => {
		const b = await setup();
		await approved(b);
		const done = await appt(b, 6000, -1, "done");
		const { charge: c1 } = await charge(b, { appointment_id: done });
		const p1 = await paymentIdOf(c1?.id as string);
		await hook(b.businessId, {
			event: "PAYMENT_CONFIRMED",
			payment: {
				id: p1,
				billingType: "CREDIT_CARD",
				installmentCount: 3,
				clientPaymentDate: new Date().toISOString(),
			},
		});
		const [t] = await sql<{ kind: string; method: string; inst: number }[]>`
      SELECT kind, payment_method AS method, installments AS inst
      FROM transactions WHERE appointment_id = ${done}`;
		expect(t).toEqual({ kind: "payment", method: "credit", inst: 3 });

		const a2 = await appt(b, 5000, 6);
		const { charge: c2 } = await charge(b, { appointment_id: a2 });
		const p2 = await paymentIdOf(c2?.id as string);
		await hook(b.businessId, { event: "PAYMENT_OVERDUE", payment: { id: p2 } });
		expect(
			(await sql`SELECT status FROM charges WHERE id = ${c2?.id as string}`)[0]
				?.status,
		).toBe("overdue");
		await hook(b.businessId, { event: "PAYMENT_DELETED", payment: { id: p2 } });
		expect(
			(await sql`SELECT status FROM charges WHERE id = ${c2?.id as string}`)[0]
				?.status,
		).toBe("canceled");
		// estorno de cobrança nunca paga: só muda a situação
		await hook(b.businessId, {
			event: "PAYMENT_REFUNDED",
			payment: { id: p2 },
		});
		expect(
			(await sql`SELECT status FROM charges WHERE id = ${c2?.id as string}`)[0]
				?.status,
		).toBe("refunded");
	});

	it("situação da conta pelo webhook (só para quem ativou)", async () => {
		const b = await setup();
		const notActivated = await setup();
		await req(b, "POST", "/v1/finance/online/account", ACTIVATE);
		const r = await hook(b.businessId, {
			event: "ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED",
		});
		expect(await r.json()).toEqual({
			ok: true,
			status: "approved",
			updated: true,
		});
		const n = await hook(notActivated.businessId, {
			event: "ACCOUNT_STATUS_GENERAL_APPROVAL_REJECTED",
		});
		expect(await n.json()).toEqual({
			ok: true,
			status: "rejected",
			updated: false,
		});
	});

	it("token errado/desligado 401; evento desconhecido, pagamento de outro negócio ou sem id → 200 ignorado", async () => {
		const b = await setup();
		const other = await setup();
		await approved(b);
		const { charge: ch } = await charge(b, {
			appointment_id: await appt(b, 8000),
		});
		const pid = await paymentIdOf(ch?.id as string);
		expect((await hook(b.businessId, {}, "errado")).status).toBe(401);
		const ignored = async (biz: string, body: unknown) =>
			expect(await (await hook(biz, body)).json()).toEqual({
				ok: true,
				ignored: true,
			});
		await ignored(b.businessId, {
			event: "PAYMENT_CREATED",
			payment: { id: pid },
		});
		await ignored(b.businessId, { event: "TRANSFER_DONE" });
		await ignored(b.businessId, { event: "PAYMENT_RECEIVED" });
		await ignored(other.businessId, {
			event: "PAYMENT_RECEIVED",
			payment: { id: pid },
		});
		await ignored(b.businessId, {
			event: "PAYMENT_RECEIVED",
			payment: { id: "pay_desconhecido" },
		});
		await ignored("nao-e-uuid", {
			event: "PAYMENT_RECEIVED",
			payment: { id: pid },
		});
		const broken = await app.request(
			`/webhooks/asaas/subaccounts/${b.businessId}`,
			{
				method: "POST",
				headers: { "asaas-access-token": ENV.ASAAS_SUBACCOUNT_WEBHOOK_TOKEN },
				body: "{",
			},
		);
		expect(await broken.json()).toEqual({ ok: true, ignored: true });
		setEnv(false);
		expect((await hook(b.businessId, {})).status).toBe(401);
	});

	it("entrega simultânea: lançamento já existe → cobrança paga sem duplicar", async () => {
		const b = await setup();
		await approved(b);
		const a = await appt(b, 5000, 4);
		const { charge: ch } = await charge(b, { appointment_id: a });
		const pid = await paymentIdOf(ch?.id as string);
		// outra entrega do mesmo pagamento já gravou o lançamento
		await sql`
      INSERT INTO transactions (business_id, type, amount_cents, category,
        appointment_id, payment_method, asaas_payment_id)
      VALUES (${b.businessId}, 'income', 5000, 'atendimento', ${a}, 'credit', ${pid})`;
		await hook(b.businessId, {
			event: "PAYMENT_CONFIRMED",
			payment: { id: pid, billingType: "CREDIT_CARD" },
		});
		const n =
			await sql`SELECT 1 FROM transactions WHERE asaas_payment_id = ${pid}`;
		expect(n).toHaveLength(1);
		expect(
			(await sql`SELECT status FROM charges WHERE id = ${ch?.id as string}`)[0]
				?.status,
		).toBe("paid");
	});

	it("crédito sem parcelas informadas = 1x; sem header → 401", async () => {
		const b = await setup();
		await approved(b);
		const a = await appt(b, 5000, -1, "done");
		const { charge: ch } = await charge(b, { appointment_id: a });
		const pid = await paymentIdOf(ch?.id as string);
		await hook(b.businessId, {
			event: "PAYMENT_RECEIVED",
			payment: { id: pid, billingType: "CREDIT_CARD" },
		});
		const [t] = await sql<{ inst: number }[]>`
      SELECT installments AS inst FROM transactions WHERE asaas_payment_id = ${pid}`;
		expect(t?.inst).toBe(1);
		const noHeader = await app.request(
			`/webhooks/asaas/subaccounts/${b.businessId}`,
			{ method: "POST", body: "{}" },
		);
		expect(noHeader.status).toBe(401);
	});

	it("methodOf", () => {
		expect(methodOf("PIX")).toBe("pix");
		expect(methodOf("CREDIT_CARD")).toBe("credit");
		expect(methodOf("DEBIT_CARD")).toBe("debit");
		expect(methodOf("BOLETO")).toBe("other");
		expect(methodOf(undefined)).toBe("other");
	});
});
