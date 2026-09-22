/**
 * Testes de integração do POST /v1/billing/checkout (Fase A).
 * fetch (Asaas) mockado; banco de teste real (:5433).
 * Os envs ASAAS_* são controlados via vi.stubEnv — o ambiente real do CI
 * NUNCA tem a key, então o caminho 503 fail-closed é o default seguro.
 */
import { eq } from "drizzle-orm";
import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({
	getApps: vi.fn(() => [{} as never]),
}));

import { createApp } from "../../src/app.js";
import { getDb } from "../../src/db/connection.js";
import { businesses, users } from "../../src/db/schema.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:***@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

let seq = 0;
const uid = () => `test-uid-bill-${Date.now()}-${seq++}`;

function authed(uidValue: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== uidValue) throw new Error("invalid");
		return { uid: uidValue, email: `${uidValue}@t.com`, name: "Pro Teste" };
	});
	return { Authorization: `Bearer ${uidValue}` };
}

async function createUser(name: string) {
	const u = uid();
	const res = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...authed(u) },
		body: JSON.stringify({ name }),
	});
	expect(res.status).toBe(201);
	return u;
}

async function businessIdOf(u: string): Promise<string> {
	const rows =
		await sql`SELECT business_id FROM users WHERE firebase_uid = ${u}`;
	const row = rows[0];
	if (!row) throw new Error("user não encontrado no banco de teste");
	return row.business_id as string;
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterEach(() => {
	fetchMock.mockReset();
	vi.unstubAllEnvs();
});

afterAll(async () => {
	// corrida: outro arquivo em paralelo pode ter apagado estes users já — ignorar FK
	try {
		await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-uid-bill-%')`;
		await sql`DELETE FROM users WHERE email LIKE 'test-uid-bill-%'`;
	} catch {
		// registro já apagado por outro worker — ok
	}
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro Teste bill%'`;
	await sql.end();
});

describe("POST /v1/billing/checkout", () => {
	it("503 fail-closed sem ASAAS_API_KEY (default do CI)", async () => {
		vi.stubEnv("ASAAS_API_KEY", "");
		const u = await createUser("Pro Teste bill Billing 503");
		const res = await app.request("/v1/billing/checkout", {
			method: "POST",
			headers: { "content-type": "application/json", ...authed(u) },
			body: JSON.stringify({ cpf_cnpj: "20447670824" }),
		});
		expect(res.status).toBe(503);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("503 com chave mas ASAAS_PLAN_VALUE inválido", async () => {
		vi.stubEnv("ASAAS_API_KEY", "k");
		vi.stubEnv("ASAAS_PLAN_VALUE", "abc");
		const u = await createUser("Pro Teste bill Billing cfg");
		const res = await app.request("/v1/billing/checkout", {
			method: "POST",
			headers: { "content-type": "application/json", ...authed(u) },
			body: JSON.stringify({ cpf_cnpj: "20447670824" }),
		});
		expect(res.status).toBe(503);
	});

	it("400 sem cpf_cnpj no body", async () => {
		vi.stubEnv("ASAAS_API_KEY", "k");
		vi.stubEnv("ASAAS_PLAN_VALUE", "2990");
		const u = await createUser("Pro Teste bill Billing NoCpf");
		const res = await app.request("/v1/billing/checkout", {
			method: "POST",
			headers: { "content-type": "application/json", ...authed(u) },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("body JSON quebrado → 400 pelo catch do json()", async () => {
		vi.stubEnv("ASAAS_API_KEY", "k");
		vi.stubEnv("ASAAS_PLAN_VALUE", "2990");
		const u = await createUser("Pro Teste bill Billing BadJson");
		const res = await app.request("/v1/billing/checkout", {
			method: "POST",
			headers: { "content-type": "application/json", ...authed(u) },
			body: "não-sou-json{{{",
		});
		expect(res.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("feliz: cria customer+subscription, persiste ids e devolve invoiceUrl", async () => {
		vi.stubEnv("ASAAS_API_KEY", "k");
		vi.stubEnv("ASAAS_PLAN_VALUE", "2990");
		const u = await createUser("Pro Teste bill Billing Ok");

		// 1ª chamada = customers, 2ª = subscriptions
		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "cus_new" }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ id: "sub_new", invoiceUrl: "https://pay/x" }),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						data: [{ invoiceUrl: "https://pay/x" }],
					}),
					{ status: 200 },
				),
			);

		const res = await app.request("/v1/billing/checkout", {
			method: "POST",
			headers: { "content-type": "application/json", ...authed(u) },
			body: JSON.stringify({ cpf_cnpj: "204.476.708-24" }),
		});
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ invoiceUrl: "https://pay/x" });
		expect(fetchMock).toHaveBeenCalledTimes(3); // customer + subscription + payments

		// ids persistidos no business
		const db = getDb(DATABASE_URL);
		const rows = await db
			.select({
				cid: businesses.asaasCustomerId,
				sid: businesses.asaasSubscriptionId,
			})
			.from(businesses)
			.innerJoin(users, eq(users.businessId, businesses.id))
			.where(eq(users.firebaseUid, u))
			.limit(1);
		const biz = rows[0];
		if (!biz) throw new Error("business não encontrado");
		expect(biz.cid).toBe("cus_new");
		expect(biz.sid).toBe("sub_new");

		// subscription com value em reais e ciclo mensal
		const subCall = fetchMock.mock.calls[1];
		if (!subCall) throw new Error("2ª chamada fetch não aconteceu");
		const [, subInit] = subCall;
		const subBody = JSON.parse(subInit?.body as string);
		expect(subBody).toMatchObject({ value: 29.9, cycle: "MONTHLY" });

		// customer criado com o cpfCnpj normalizado
		const custCall = fetchMock.mock.calls[0];
		if (!custCall) throw new Error("1ª chamada fetch não aconteceu");
		const [custUrl2, custInit] = custCall;
		expect(String(custUrl2)).toContain("/v3/customers");
		expect(JSON.parse(custInit?.body as string).cpfCnpj).toBe("20447670824");
	});

	it("reusa o asaas_customer_id existente (1 chamada de rede)", async () => {
		vi.stubEnv("ASAAS_API_KEY", "k");
		vi.stubEnv("ASAAS_PLAN_VALUE", "2990");
		const u = await createUser("Pro Teste bill Billing Reuse");
		const db = getDb(DATABASE_URL);
		await db
			.update(businesses)
			.set({ asaasCustomerId: "cus_existing" })
			.where(eq(businesses.id, await businessIdOf(u)));

		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "cus_existing" }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "sub_new2" }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						data: [{ invoiceUrl: "https://pay/x2" }],
					}),
					{ status: 200 },
				),
			);

		const res = await app.request("/v1/billing/checkout", {
			method: "POST",
			headers: { "content-type": "application/json", ...authed(u) },
			body: JSON.stringify({ cpf_cnpj: "20447670824" }),
		});
		expect(res.status).toBe(201);
		expect(fetchMock).toHaveBeenCalledTimes(3); // update CPF + subscription + payments
		const reuseCall = fetchMock.mock.calls[0];
		if (!reuseCall) throw new Error("fetch não chamado");
		const [custUrl] = reuseCall;
		expect(String(custUrl)).toContain("/v3/customers/cus_existing");
	});

	it("409 quando o business já tem assinatura", async () => {
		vi.stubEnv("ASAAS_API_KEY", "k");
		vi.stubEnv("ASAAS_PLAN_VALUE", "2990");
		const u = await createUser("Pro Teste bill Billing Dup");
		const db = getDb(DATABASE_URL);
		await db
			.update(businesses)
			.set({ asaasSubscriptionId: "sub_dup" })
			.where(eq(businesses.id, await businessIdOf(u)));

		const res = await app.request("/v1/billing/checkout", {
			method: "POST",
			headers: { "content-type": "application/json", ...authed(u) },
			body: JSON.stringify({ cpf_cnpj: "20447670824" }),
		});
		expect(res.status).toBe(409);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("503 quando o Asaas falha (sem vazar erro interno)", async () => {
		vi.stubEnv("ASAAS_API_KEY", "k");
		vi.stubEnv("ASAAS_PLAN_VALUE", "2990");
		const u = await createUser("Pro Teste bill Billing Fail");
		fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

		const res = await app.request("/v1/billing/checkout", {
			method: "POST",
			headers: { "content-type": "application/json", ...authed(u) },
			body: JSON.stringify({ cpf_cnpj: "20447670824" }),
		});
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			error: "Cobrança indisponível no momento",
		});
	});

	it("usa bankSlipUrl quando o payment não tem invoiceUrl", async () => {
		vi.stubEnv("ASAAS_API_KEY", "k");
		vi.stubEnv("ASAAS_PLAN_VALUE", "2990");
		const u = await createUser("Pro Teste bill Billing Slip");
		// payments sem invoiceUrl, sem bankSlipUrl, e data vazio → null
		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "cus_s" }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "sub_s" }), { status: 200 }),
			)
			.mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [{ bankSlipUrl: "https://pay/slip.pdf" }],
					}),
					{ status: 200 },
				),
			);
		const res = await app.request("/v1/billing/checkout", {
			method: "POST",
			headers: { "content-type": "application/json", ...authed(u) },
			body: JSON.stringify({ cpf_cnpj: "20447670824" }),
		});
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ invoiceUrl: "https://pay/slip.pdf" });
	});

	it("GET /payments com erro HTTP → invoiceUrl null (fail-closed)", {
		timeout: 20000,
	}, async () => {
		vi.stubEnv("ASAAS_API_KEY", "k");
		vi.stubEnv("ASAAS_PLAN_VALUE", "2990");
		const u = await createUser("Pro Teste bill Billing PayErr");
		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "cus_e" }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "sub_e" }), { status: 200 }),
			)
			.mockResolvedValue(new Response("erro", { status: 500 }));
		const res = await app.request("/v1/billing/checkout", {
			method: "POST",
			headers: { "content-type": "application/json", ...authed(u) },
			body: JSON.stringify({ cpf_cnpj: "20447670824" }),
		});
		// checkout criado (201); só a busca da URL falhou (best-effort)
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ invoiceUrl: null });
	});

	it("pagamentos sem URL nenhuma → invoiceUrl null após os retries", {
		timeout: 30000,
	}, async () => {
		vi.stubEnv("ASAAS_API_KEY", "k");
		vi.stubEnv("ASAAS_PLAN_VALUE", "2990");
		const u = await createUser("Pro Teste bill Billing Null");
		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "cus_n" }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "sub_n" }), { status: 200 }),
			)
			.mockResolvedValue(
				new Response(JSON.stringify({ data: [] }), { status: 200 }),
			);
		const res = await app.request("/v1/billing/checkout", {
			method: "POST",
			headers: { "content-type": "application/json", ...authed(u) },
			body: JSON.stringify({ cpf_cnpj: "20447670824" }),
		});
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ invoiceUrl: null });
	});
});
