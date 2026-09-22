/**
 * Testes do webhook Asaas (Fase B).
 * Banco de teste real (:5433); env via vi.stubEnv.
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
import { businesses } from "../../src/db/schema.js";
import {
	asaasWebhookRoutes,
	eventToStatus,
} from "../../src/routes/asaas-webhook.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:***@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

// App mínimo só com o webhook (sem Firebase mock atrapalhando) pra rotas raiz
const webhookApp = asaasWebhookRoutes(DATABASE_URL);

let seq = 0;
const uid = () => `test-uid-wh-${Date.now()}-${seq++}`;

function authed(uidValue: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== uidValue) throw new Error("invalid");
		return { uid: uidValue, email: `${uidValue}@t.com`, name: "Pro Teste" };
	});
	return { Authorization: `Bearer ${uidValue}` };
}

const TOKEN = "wh-secret";
function hook(body: unknown, token: string = TOKEN) {
	return webhookApp.request("/webhooks/asaas", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"asaas-access-token": token,
		},
		body: JSON.stringify(body),
	});
}

async function businessIdOf(u: string): Promise<string> {
	const rows =
		await sql`SELECT business_id FROM users WHERE firebase_uid = ${u}`;
	const row = rows[0];
	if (!row) throw new Error("user não encontrado no banco de teste");
	return row.business_id as string;
}

async function createBusinessWithCustomer(
	name: string,
	customerId: string,
	status: string,
): Promise<string> {
	const u = uid();
	const res = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...authed(u) },
		body: JSON.stringify({ name }),
	});
	expect(res.status).toBe(201);
	const db = getDb(DATABASE_URL);
	const bizId = await businessIdOf(u);
	const rows = await db
		.update(businesses)
		.set({ asaasCustomerId: customerId, subscriptionStatus: status })
		.where(eq(businesses.id, bizId))
		.returning({ id: businesses.id });
	const biz = rows[0];
	if (!biz) throw new Error("business não encontrado");
	return biz.id;
}

async function statusOf(bizId: string): Promise<string> {
	const db = getDb(DATABASE_URL);
	const rows = await db
		.select({ s: businesses.subscriptionStatus })
		.from(businesses)
		.where(eq(businesses.id, bizId));
	return rows[0]?.s ?? "?";
}

beforeAll(async () => {
	await sql`SELECT 1`;
	vi.stubEnv("ASAAS_WEBHOOK_TOKEN", TOKEN);
});

afterEach(() => {
	// manter o token stubado entre testes (afterEach do unstubAll não é usado aqui)
});

afterAll(async () => {
	await sql`DELETE FROM users WHERE email LIKE 'test-uid-wh-%'`;
	// Prefixo exclusivo: outros arquivos limpam LIKE 'Pro Teste%' em paralelo
	// e apagavam os businesses deste teste no meio da execução (contaminação).
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro Teste Wh %'`;
	await sql.end();
	vi.unstubAllEnvs();
});

describe("eventToStatus (unit)", () => {
	it("mapeia eventos do Asaas para estados internos", () => {
		expect(eventToStatus("PAYMENT.CONFIRMED")).toBe("active");
		expect(eventToStatus("PAYMENT.RECEIVED")).toBe("active");
		expect(eventToStatus("PAYMENT.OVERDUE")).toBe("past_due");
		expect(eventToStatus("SUBSCRIPTION.CANCELED")).toBe("canceled");
		expect(eventToStatus("PAYMENT.REFUNDED")).toBe("canceled");
		expect(eventToStatus("PAYMENT.CREATED")).toBeNull();
		expect(eventToStatus("")).toBeNull();
		expect(eventToStatus("EVENTO.INEXISTENTE")).toBeNull();
	});
});

describe("POST /webhooks/asaas", () => {
	it("401 sem header / token errado / sem env", async () => {
		vi.stubEnv("ASAAS_WEBHOOK_TOKEN", TOKEN);
		const noHeader = await webhookApp.request("/webhooks/asaas", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ event: "PAYMENT.CONFIRMED" }),
		});
		expect(noHeader.status).toBe(401);

		const wrong = await hook({ event: "PAYMENT.CONFIRMED" }, "errado");
		expect(wrong.status).toBe(401);

		vi.stubEnv("ASAAS_WEBHOOK_TOKEN", "");
		const noEnv = await hook({ event: "PAYMENT.CONFIRMED" });
		expect(noEnv.status).toBe(401);
		vi.stubEnv("ASAAS_WEBHOOK_TOKEN", TOKEN);
	});

	it("PAYMENT.CONFIRMED → active (substitui trial; trial_ends_at fica)", async () => {
		const bizId = await createBusinessWithCustomer(
			"Pro Teste Wh Confirm",
			"cus_wh1",
			"trial",
		);
		const res = await hook({
			event: "PAYMENT.CONFIRMED",
			payment: { customer: "cus_wh1" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, status: "active" });
		expect(await statusOf(bizId)).toBe("active");
	});

	it("PAYMENT.OVERDUE → past_due", async () => {
		const bizId = await createBusinessWithCustomer(
			"Pro Teste Wh Overdue",
			"cus_wh2",
			"active",
		);
		const res = await hook({
			event: "PAYMENT.OVERDUE",
			payment: { customer: "cus_wh2" },
		});
		expect(res.status).toBe(200);
		expect(await statusOf(bizId)).toBe("past_due");
	});

	it("SUBSCRIPTION.CANCELED → canceled", async () => {
		const bizId = await createBusinessWithCustomer(
			"Pro Teste Wh Cancel",
			"cus_wh3",
			"active",
		);
		const res = await hook({
			event: "SUBSCRIPTION.CANCELED",
			subscription: { customer: "cus_wh3" },
		});
		expect(res.status).toBe(200);
		expect(await statusOf(bizId)).toBe("canceled");
	});

	it("PAYMENT.REFUNDED → canceled", async () => {
		const bizId = await createBusinessWithCustomer(
			"Pro Teste Wh Refund",
			"cus_wh4",
			"active",
		);
		const _res = await hook({
			event: "PAYMENT.REFUNDED",
			payment: { customer: "cus_wh4" },
		});
		expect(await statusOf(bizId)).toBe("canceled");
	});

	it("idempotente: evento repetido não muda nada (e responde 200)", async () => {
		const bizId = await createBusinessWithCustomer(
			"Pro Teste Wh Dup",
			"cus_wh5",
			"active",
		);
		const body = {
			event: "PAYMENT.CONFIRMED",
			payment: { customer: "cus_wh5" },
		};
		await hook(body);
		await hook(body);
		await hook(body);
		expect(await statusOf(bizId)).toBe("active");
	});

	it("evento desconhecido → 200 ignored (nunca 4xx pro Asaas)", async () => {
		const res = await hook({
			event: "PAYMENT.CREATED",
			payment: { customer: "cus_x" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, ignored: true });
	});

	it("body quebrado → 200 (não dar 4xx pro Asaas re-tentar forever)", async () => {
		const res = await webhookApp.request("/webhooks/asaas", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"asaas-access-token": TOKEN,
			},
			body: "isto não é json{{{",
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, ignored: true });
	});

	it("customer desconhecido → 200 ignored com log", async () => {
		const res = await hook({
			event: "PAYMENT.CONFIRMED",
			payment: { customer: "cus_outro_ambiente" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, ignored: true });
	});

	it("evento com status mas sem customer → 200 ignored", async () => {
		const res = await hook({ event: "PAYMENT.CONFIRMED" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, ignored: true });
	});

	it("webhook é PÚBLICO (acessível pelo app completo sem Firebase)", async () => {
		// pelo app inteiro: sem Authorization, sem passar pelo auth do /v1
		const res = await app.request("/webhooks/asaas", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"asaas-access-token": TOKEN,
			},
			body: JSON.stringify({
				event: "PAYMENT.CONFIRMED",
				payment: { customer: "cus_nao_existe" },
			}),
		});
		// 401 seria falha do Firebase; 200 prova que nem chegou lá
		expect(res.status).toBe(200);
	});
});
