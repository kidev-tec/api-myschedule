/**
 * DELETE /v1/auth/account — exclusão de conta (LGPD art. 18, VI).
 * Integração REAL contra Postgres docker. Firebase mockado (deleteUser spy).
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
const deleteSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock, deleteUser: deleteSpy }),
}));
vi.mock("firebase-admin/app", () => ({
	getApps: vi.fn(() => [{} as never]),
}));

import { createApp } from "../../src/app.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:***@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = 0;
const uid = () => `test-uid-accdel-${Date.now()}-${seq++}`;
function authed(u: string) {
	verifyMock.mockImplementation(async (t: string) => {
		if (t !== u) throw new Error("invalid token");
		return { uid: u, email: `${u}@t.com`, name: "Pro AccDel" };
	});
	return { Authorization: `Bearer ${u}` };
}

async function bizIdOf(u: string): Promise<string> {
	const rows =
		await sql`SELECT business_id FROM users WHERE firebase_uid = ${u}`;
	return (rows[0] as { business_id: string } | undefined)?.business_id ?? "";
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	// sobra só se algum teste falhou no meio (a rota já limpa tudo)
	await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-uid-accdel-%')`;
	await sql`DELETE FROM users WHERE email LIKE 'test-uid-accdel-%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro AccDel%'`;
	await sql.end();
});

describe("DELETE /v1/auth/account", () => {
	it("404 se user não existe no Postgres", async () => {
		const u = uid();
		authed(u); // token válido, mas nunca fez sync
		const res = await app.request("/v1/auth/account", {
			method: "DELETE",
			headers: authed(u),
		});
		expect(res.status).toBe(404);
	});

	it("apaga user+business+dados em cascata e o registro no Firebase", async () => {
		const h = authed(uid());
		const u = h.Authorization.slice("Bearer ".length);
		const sync = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro AccDel Salao" }),
		});
		expect(sync.status).toBe(201);
		const bizId = await bizIdOf(u);
		expect(bizId).not.toBe("");

		// cria dados reais em todas as tabelas filhas
		const svc = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Corte",
				duration_min: 30,
				price_cents: 5000,
			}),
		});
		expect(svc.status).toBe(201);
		const svcBody = (await svc.json()) as { id: string };
		const cli = await sql`
      INSERT INTO clients (business_id, name, phone_e164) VALUES (${bizId}, 'Ana', '+5511999000111') RETURNING id`;
		const cliId = (cli[0] as { id: string }).id;
		await sql`
      INSERT INTO appointments (business_id, client_id, service_id, user_id, starts_at, ends_at)
      VALUES (${bizId}, ${cliId}, ${svcBody.id}, (SELECT id FROM users WHERE firebase_uid = ${u}), now() + interval '10 days', now() + interval '10 days 30 minutes')`;
		await sql`
      INSERT INTO transactions (business_id, type, amount_cents, category) VALUES (${bizId}, 'income', 5000, 'serviço')`;
		await sql`
      INSERT INTO message_templates (business_id, kind, body) VALUES (${bizId}, 'reminder', 'te lembramos!')`;
		await sql`
      INSERT INTO subscriptions (business_id, platform, external_id, status) VALUES (${bizId}, 'play', 'sub_x', 'active')`;
		await sql`
      INSERT INTO working_hours (user_id, weekday, start_time, end_time) VALUES ((SELECT id FROM users WHERE firebase_uid = ${u}), 1, '09:00', '18:00')`;

		deleteSpy.mockClear();
		const res = await app.request("/v1/auth/account", {
			method: "DELETE",
			headers: h,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			firebaseDeleted: boolean;
		};
		expect(body.ok).toBe(true);
		expect(body.firebaseDeleted).toBe(true);
		expect(deleteSpy).toHaveBeenCalledWith(u);

		// nada sobrou em nenhuma tabela
		const leftovers = await sql`
      SELECT
        (SELECT count(*)::int FROM users WHERE firebase_uid = ${u}) AS users,
        (SELECT count(*)::int FROM businesses WHERE id = ${bizId}) AS businesses,
        (SELECT count(*)::int FROM services WHERE business_id = ${bizId}) AS services,
        (SELECT count(*)::int FROM clients WHERE business_id = ${bizId}) AS clients,
        (SELECT count(*)::int FROM appointments WHERE business_id = ${bizId}) AS appointments,
        (SELECT count(*)::int FROM transactions WHERE business_id = ${bizId}) AS transactions,
        (SELECT count(*)::int FROM message_templates WHERE business_id = ${bizId}) AS templates,
        (SELECT count(*)::int FROM subscriptions WHERE business_id = ${bizId}) AS subs,
        (SELECT count(*)::int FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE firebase_uid = ${u})) AS wh`;
		const row = leftovers[0] as Record<string, number>;
		for (const k of Object.keys(row)) {
			expect(row[k]).toBe(0);
		}
	});

	it("rota exige auth (401 sem token)", async () => {
		const res = await app.request("/v1/auth/account", { method: "DELETE" });
		expect(res.status).toBe(401);
	});

	it("Firebase falha ao deletar → resposta ok com firebaseDeleted=false", async () => {
		const h = authed(uid());
		const u = h.Authorization.slice("Bearer ".length);
		const sync = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro AccDel FirebaseFalha" }),
		});
		expect(sync.status).toBe(201);

		deleteSpy.mockImplementationOnce(async () => {
			throw new Error("firebase fora do ar");
		});
		const res = await app.request("/v1/auth/account", {
			method: "DELETE",
			headers: h,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			firebaseDeleted: boolean;
		};
		expect(body.ok).toBe(true);
		expect(body.firebaseDeleted).toBe(false);
		// Postgres limpo mesmo com Firebase falhando
		const rows =
			await sql`SELECT count(*)::int AS n FROM users WHERE firebase_uid = ${u}`;
		expect((rows[0] as { n: number }).n).toBe(0);
	});

	it("exclusão é idempotente no login seguinte: sync recria conta limpa", async () => {
		const h = authed(uid());
		const u = h.Authorization.slice("Bearer ".length);
		await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro AccDel Volta" }),
		});
		const del = await app.request("/v1/auth/account", {
			method: "DELETE",
			headers: h,
		});
		expect(del.status).toBe(200);
		// login de novo (mesmo uid): recria do zero
		const sync2 = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro AccDel Volta 2" }),
		});
		expect(sync2.status).toBe(201);
		const biz2 = bizIdOf(u);
		expect(biz2).not.toBe("");
		// e exclusão de novo funciona (limpa pro afterAll)
		const del2 = await app.request("/v1/auth/account", {
			method: "DELETE",
			headers: h,
		});
		expect(del2.status).toBe(200);
	});
});
