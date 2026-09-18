/**
 * Integração REAL: BARRA B10 — painel da Oficina (escola).
 * Firebase mockado, Postgres docker real. SCHOOL_KEY via env de teste.
 *
 * Cenários:
 * - 503 sem SCHOOL_KEY configurada (fail-closed)
 * - 401 com header errado
 * - GET subscribers: lista business com status/trial/expiring/expired
 * - filtro ?filter=expiring só traz expirando/expirados
 * - POST renew: ativa assinatura (30d) e renova trial com days
 * - 400 business_id inválido / 404 inexistente
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());

vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({
	getApps: vi.fn(() => [{} as never]),
}));

import { createApp } from "../../src/app.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:postgres@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const SCHOOL_KEY = "test-school-key-123";
// env definida no load do módulo (antes de qualquer request)
process.env.SCHOOL_KEY = SCHOOL_KEY;

const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

const H = { "x-school-key": SCHOOL_KEY };

let seq = 0;
const uid = () => `test-uid-${Date.now()}-${seq++}`;

async function makeBusiness(name: string, trialEndsAt: Date | null, status = "trial") {
	verifyMock.mockImplementation(async (t: string) => ({
		uid: t,
		email: `${t}@t.com`,
		name: "X",
	}));
	const u = `school-uid-${Date.now()}-${seq++}`;
	const unique = `${name} ${Date.now()}-${seq++}`;
	const sync = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${u}` },
		body: JSON.stringify({ name: unique }),
	});
	expect(sync.status).toBe(201);
	// ajusta trial/status direto no banco
	if (trialEndsAt === null) {
		await sql`UPDATE businesses SET trial_ends_at = NULL, subscription_status = ${status} WHERE name = ${unique}`;
	} else {
		await sql`UPDATE businesses SET trial_ends_at = ${trialEndsAt.toISOString()}, subscription_status = ${status} WHERE name = ${unique}`;
	}
	const rows = await sql<{ id: string }[]>`
		SELECT id FROM businesses WHERE name = ${unique} LIMIT 1`;
	return { businessId: rows[0]?.id ?? "", uid: u, name: unique };
}

beforeAll(async () => {
	process.env.SCHOOL_KEY = SCHOOL_KEY;
	await sql`SELECT 1`;
});

afterAll(async () => {
	delete process.env.SCHOOL_KEY;
	await sql`DELETE FROM users WHERE email LIKE 'school-uid-%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'School Test%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'School T%'`;
	await sql.end();
});

describe("auth do painel escola (B10)", () => {
	it("503 fail-closed sem SCHOOL_KEY", async () => {
		const prev = process.env.SCHOOL_KEY;
		delete process.env.SCHOOL_KEY;
		try {
			const res = await app.request("/v1/internal/school/subscribers", {
				headers: H,
			});
			expect(res.status).toBe(503);
		} finally {
			process.env.SCHOOL_KEY = prev;
		}
	});

	it("401 com key errada", async () => {
		const res = await app.request("/v1/internal/school/subscribers", {
			headers: { "x-school-key": "errada" },
		});
		expect(res.status).toBe(401);
	});
});

describe("GET /internal/school/subscribers", () => {
	it("lista assinantes com flags expiring/expired", async () => {
		const now = Date.now();
		const { businessId: bizA, name: nameA } = await makeBusiness("School Test A", new Date(now + 2 * 86_400_000)); // expiring
		const { name: nameB } = await makeBusiness("School Test B", new Date(now - 1 * 86_400_000)); // expired
		const { name: nameC } = await makeBusiness("School Test C", new Date(now + 20 * 86_400_000)); // ok
		const { name: nameD } = await makeBusiness("School Test D", new Date(now + 30 * 86_400_000), "active");

		const res = await app.request("/v1/internal/school/subscribers", { headers: H });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			subscribers: {
				name: string;
				subscription_status: string;
				expired: boolean;
				expiring: boolean;
				owner_email: string | null;
			}[];
		};
		const a = body.subscribers.find((s) => s.name === nameA);
		const b = body.subscribers.find((s) => s.name === nameB);
		const cRow = body.subscribers.find((s) => s.name === nameC);
		const d = body.subscribers.find((s) => s.name === nameD);
		expect(a?.expiring).toBe(true);
		expect(b?.expired).toBe(true);
		expect(cRow?.expiring).toBe(false);
		expect(cRow?.expired).toBe(false);
		expect(
			d?.subscription_status,
			`D não achado. names=${body.subscribers.map((s) => s.name).join(" | ")}`,
		).toBe("active");
		// contato do dono presente
		expect(a?.owner_email).toContain("@t.com");
	});

	it("filtro ?filter=expiring traz só expirando/expirados", async () => {
		const res = await app.request(
			"/v1/internal/school/subscribers?filter=expiring",
			{ headers: H },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			subscribers: { name: string; expiring: boolean; expired: boolean }[];
		};
		expect(body.subscribers.length).toBeGreaterThanOrEqual(2);
		expect(
			body.subscribers.every((s) => s.expiring || s.expired),
		).toBe(true);
	});
});

describe("POST /internal/school/renew", () => {
	it("ativa assinatura (sem days) → status active + 30d", async () => {
		const { businessId } = await makeBusiness(
			"School Test Renew1",
			new Date(Date.now() - 5 * 86_400_000), // expirado
		);
		const res = await app.request("/v1/internal/school/renew", {
			method: "POST",
			headers: { "content-type": "application/json", ...H },
			body: JSON.stringify({ business_id: businessId }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			subscription_status: string;
			trial_ends_at: string;
		};
		expect(body.subscription_status).toBe("active");
		const days =
			(new Date(body.trial_ends_at).getTime() - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(29);
		expect(days).toBeLessThan(31);
	});

	it("renova trial com days → acumula sobre o trial atual", async () => {
		const { businessId } = await makeBusiness(
			"School Test Renew2",
			new Date(Date.now() + 10 * 86_400_000), // ainda tem 10 dias
		);
		const res = await app.request("/v1/internal/school/renew", {
			method: "POST",
			headers: { "content-type": "application/json", ...H },
			body: JSON.stringify({ business_id: businessId, days: 15 }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { trial_ends_at: string };
		const days =
			(new Date(body.trial_ends_at).getTime() - Date.now()) / 86_400_000;
		// 10 dias restantes + 15 novos ≈ 25
		expect(days).toBeGreaterThan(24);
		expect(days).toBeLessThan(26);
	});

	it("renova trial de conta sem trial_ends_at (NULL) → conta a partir de agora", async () => {
		const { businessId } = await makeBusiness("School Test Renew4", null);
		const res = await app.request("/v1/internal/school/renew", {
			method: "POST",
			headers: { "content-type": "application/json", ...H },
			body: JSON.stringify({ business_id: businessId, days: 7 }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { trial_ends_at: string };
		const days =
			(new Date(body.trial_ends_at).getTime() - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(6);
		expect(days).toBeLessThan(8);
	});

	it("400 com body não-JSON", async () => {
		const res = await app.request("/v1/internal/school/renew", {
			method: "POST",
			headers: { "content-type": "application/json", ...H },
			body: "{quebrado",
		});
		expect(res.status).toBe(400);
	});

	it("400 com business_id inválido / 404 inexistente", async () => {
		const bad = await app.request("/v1/internal/school/renew", {
			method: "POST",
			headers: { "content-type": "application/json", ...H },
			body: JSON.stringify({ business_id: "não-uuid" }),
		});
		expect(bad.status).toBe(400);

		const missing = await app.request("/v1/internal/school/renew", {
			method: "POST",
			headers: { "content-type": "application/json", ...H },
			body: JSON.stringify({
				business_id: "00000000-0000-0000-0000-000000000009",
			}),
		});
		expect(missing.status).toBe(404);
	});

	it("400 com days inválido (0, float, string)", async () => {
		const { businessId } = await makeBusiness(
			"School Test Renew3",
			new Date(Date.now() + 86_400_000),
		);
		for (const days of [0, 1.5, "10", 400]) {
			const res = await app.request("/v1/internal/school/renew", {
				method: "POST",
				headers: { "content-type": "application/json", ...H },
				body: JSON.stringify({ business_id: businessId, days }),
			});
			expect(res.status, `days=${days}`).toBe(400);
		}
	});

	it("401 sem header da escola", async () => {
		const res = await app.request("/v1/internal/school/renew", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ business_id: "00000000-0000-0000-0000-000000000001" }),
		});
		expect(res.status).toBe(401);
	});
});
