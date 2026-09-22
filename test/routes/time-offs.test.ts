/**
 * F3 — bloqueios de agenda (time-offs): CRUD autenticado + impacto no
 * /busy público. Integração REAL contra Postgres docker.
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
	"postgres://postgres:***@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = 0;
const uid = () => `test-uid-toff-${Date.now()}-${seq++}`;
function authed(u: string) {
	verifyMock.mockImplementation(async (t: string) => {
		if (t !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: "Pro ToOff" };
	});
	return { Authorization: `Bearer ${u}` };
}

async function syncUser(h: Record<string, string>) {
	return app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({ name: `Pro ToOff ${Date.now()}-${seq}` }),
	});
}

async function slugOf(h: Record<string, string>): Promise<string> {
	const rows = await sql`
    SELECT b.slug FROM businesses b JOIN users u ON u.business_id = b.id
    WHERE u.firebase_uid = ${h.Authorization!.slice("Bearer ".length)}`;
	return (rows[0] as { slug: string }).slug;
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	try {
		await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro ToOff%')`;
		await sql`DELETE FROM time_offs WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro ToOff%')`;
		await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro ToOff%')`;
		await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro ToOff%')`;
		await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-uid-toff-%')`;
		await sql`DELETE FROM users WHERE email LIKE 'test-uid-toff-%'`;
		await sql`DELETE FROM businesses WHERE name LIKE 'Pro ToOff%'`;
	} catch {
		// corrida com outro worker — ok
	}
	await sql.end();
});

describe("F3 /v1/time-offs", () => {
	it("400: ends_at antes de starts_at; datas inválidas", async () => {
		const h = authed(uid());
		await syncUser(h);
		const badRange = await app.request("/v1/time-offs", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				starts_at: "2026-10-01T12:00:00Z",
				ends_at: "2026-10-01T11:00:00Z",
			}),
		});
		expect(badRange.status).toBe(400);
		const badDate = await app.request("/v1/time-offs", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				starts_at: "xyz",
				ends_at: "2026-10-01T11:00:00Z",
			}),
		});
		expect(badDate.status).toBe(400);
	});

	it("cria bloqueio, lista e delete", async () => {
		const h = authed(uid());
		await syncUser(h);
		const created = await app.request("/v1/time-offs", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				starts_at: new Date(Date.now() + 86_400_000).toISOString(),
				ends_at: new Date(Date.now() + 90_000_000).toISOString(),
				reason: "Almoço",
			}),
		});
		expect(created.status).toBe(201);
		const body = (await created.json()) as { id: string; reason: string };
		expect(body.reason).toBe("Almoço");

		const list = await app.request("/v1/time-offs", { headers: h });
		const items = (await list.json()) as { id: string }[];
		expect(items.some((i) => i.id === body.id)).toBe(true);

		const del = await app.request(`/v1/time-offs/${body.id}`, {
			method: "DELETE",
			headers: h,
		});
		expect(del.status).toBe(200);
		const list2 = await app.request("/v1/time-offs", { headers: h });
		const items2 = (await list2.json()) as { id: string }[];
		expect(items2.some((i) => i.id === body.id)).toBe(false);
	});

	it("409: bloqueio engoliria agendamento ativo existente", async () => {
		const h = authed(uid());
		await syncUser(h);
		const bizId = (
			(
				await sql`
        SELECT business_id FROM users WHERE firebase_uid = ${h.Authorization!.slice("Bearer ".length)}`
			)[0] as { business_id: string }
		).business_id;
		const svc = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Corte",
				duration_min: 30,
				price_cents: 5000,
			}),
		});
		const svcBody = (await svc.json()) as { id: string };
		const cli = await sql`
      INSERT INTO clients (business_id, name, phone_e164) VALUES (${bizId}, 'C', '+5511900001111') RETURNING id`;
		const cliId = (cli[0] as { id: string }).id;
		const u = h.Authorization!.slice("Bearer ".length);
		await sql`
      INSERT INTO appointments (business_id, client_id, service_id, user_id, starts_at, ends_at)
      VALUES (${bizId}, ${cliId}, ${svcBody.id}, (SELECT id FROM users WHERE firebase_uid = ${u}),
        now() + interval '2 hours', now() + interval '2 hours 30 minutes')`;

		// bloqueio cobrindo o appointment → 409
		const res = await app.request("/v1/time-offs", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				starts_at: new Date(Date.now() + 3_600_000).toISOString(),
				ends_at: new Date(Date.now() + 10_800_000).toISOString(),
			}),
		});
		expect(res.status).toBe(409);
	});

	it("DELETE de bloqueio inexistente → 404", async () => {
		const h = authed(uid());
		await syncUser(h);
		const res = await app.request(
			`/v1/time-offs/00000000-0000-0000-0000-000000000000`,
			{ method: "DELETE", headers: h },
		);
		expect(res.status).toBe(404);
	});

	it("/p/:slug/busy inclui bloqueios com blocked=true", async () => {
		const h = authed(uid());
		await syncUser(h);
		const slug = await slugOf(h);
		// bloqueio amanhã 12:00-13:00 UTC
		const start = new Date(Date.now() + 86_400_000);
		start.setUTCHours(12, 0, 0, 0);
		const end = new Date(start.getTime() + 3_600_000);
		await app.request("/v1/time-offs", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				starts_at: start.toISOString(),
				ends_at: end.toISOString(),
			}),
		});

		const day = start.toISOString().slice(0, 10);
		const busy = await app.request(`/p/${slug}/busy?date=${day}`);
		expect(busy.status).toBe(200);
		const body = (await busy.json()) as {
			busy: { start: string; blocked?: boolean }[];
		};
		expect(body.busy.some((b) => b.blocked === true)).toBe(true);
	});
});

describe("F3 — appointment em horário bloqueado → 409", () => {
	it("POST /appointments dentro de bloqueio → 409 com hint", async () => {
		const h = authed(uid());
		await syncUser(h);
		const bizId = (
			(
				await sql`
        SELECT business_id FROM users WHERE firebase_uid = ${h.Authorization!.slice("Bearer ".length)}`
			)[0] as { business_id: string }
		).business_id;
		const svc = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Barba",
				duration_min: 30,
				price_cents: 4000,
			}),
		});
		const svcBody = (await svc.json()) as { id: string };
		const cli = await sql`
      INSERT INTO clients (business_id, name, phone_e164) VALUES (${bizId}, 'D', '+5511900002222') RETURNING id`;
		const cliId = (cli[0] as { id: string }).id;

		// bloqueio amanhã
		const blockStart = new Date(Date.now() + 86_400_000);
		const blockEnd = new Date(blockStart.getTime() + 7_200_000);
		const toff = await app.request("/v1/time-offs", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				starts_at: blockStart.toISOString(),
				ends_at: blockEnd.toISOString(),
			}),
		});
		expect(toff.status).toBe(201);

		// appointment dentro do bloqueio → 409
		const res = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: cliId,
				serviceId: svcBody.id,
				startsAt: new Date(blockStart.getTime() + 1_800_000).toISOString(),
				endsAt: new Date(blockStart.getTime() + 3_600_000).toISOString(),
			}),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { hint: string };
		expect(body.hint).toContain("bloqueado");
	});
});

describe("F3 — delete: id inválido e de outro user", () => {
	it("id não-uuid → 400", async () => {
		const h = authed(uid());
		await syncUser(h);
		const res = await app.request("/v1/time-offs/nao-e-uuid", {
			method: "DELETE",
			headers: h,
		});
		expect(res.status).toBe(400);
	});

	it("bloqueio de outro user → 404 (não vaza existência)", async () => {
		const hOwner = authed(uid());
		await syncUser(hOwner);
		const created = await app.request("/v1/time-offs", {
			method: "POST",
			headers: { "content-type": "application/json", ...hOwner },
			body: JSON.stringify({
				starts_at: new Date(Date.now() + 172_800_000).toISOString(),
				ends_at: new Date(Date.now() + 176_400_000).toISOString(),
			}),
		});
		const { id } = (await created.json()) as { id: string };

		const hOther = authed(uid());
		await syncUser(hOther);
		const res = await app.request(`/v1/time-offs/${id}`, {
			method: "DELETE",
			headers: hOther,
		});
		expect(res.status).toBe(404);
	});
});

describe("F3 — POST com body quebrado", () => {
	it("JSON inválido → 400 (catch do json retorna null)", async () => {
		const h = authed(uid());
		await syncUser(h);
		const res = await app.request("/v1/time-offs", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: "nao-e-json{",
		});
		expect(res.status).toBe(400);
	});
});
