/**
 * F5 — lista de espera: entrada pública, visualização do prestador,
 * mark notified/served, e push de vaga-aberta no cancelamento.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
const sendMock = vi.hoisted(() => vi.fn(async () => "ok"));

vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({
	getApps: vi.fn(() => [{} as never]),
}));
vi.mock("firebase-admin/messaging", () => ({
	getMessaging: () => ({ send: sendMock }),
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
const uid = () => `test-uid-wait-${Date.now()}-${seq++}`;
const knownUids = new Set<string>();
function authed(u: string) {
	knownUids.add(u);
	verifyMock.mockImplementation(async (t: string) => {
		if (!knownUids.has(t)) throw new Error("invalid");
		return { uid: t, email: `${t}@t.com`, name: "Pro Wait" };
	});
	return { Authorization: `Bearer ${u}` };
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	try {
		await sql`DELETE FROM waitlist WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Wait%')`;
		await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Wait%')`;
		await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Wait%')`;
		await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Wait%')`;
		await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-uid-wait-%')`;
		await sql`DELETE FROM users WHERE email LIKE 'test-uid-wait-%'`;
		await sql`DELETE FROM businesses WHERE name LIKE 'Pro Wait%'`;
	} catch {
		// corrida — ok
	}
	await sql.end();
});

async function setup() {
	const h = authed(uid());
	await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({ name: `Pro Wait ${Date.now()}-${seq++}` }),
	});
	const me = await app.request("/v1/me", { headers: h });
	const meBody = (await me.json()) as { slug: string; id: string };
	return { h, slug: meBody.slug, bizId: meBody.id };
}

describe("F5 waitlist", () => {
	it("cliente entra pela página pública (201), duplicado → 409", async () => {
		const { h, slug } = await setup();
		const tomorrow = new Date(Date.now() + 86_400_000)
			.toISOString()
			.slice(0, 10);
		const ok = await app.request(`/v1/p/${slug}/waitlist`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "Zé Espera",
				phone: "+5511966665555",
				desired_date: tomorrow,
			}),
		});
		expect(ok.status).toBe(201);

		const dup = await app.request(`/v1/p/${slug}/waitlist`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "Zé Espera",
				phone: "+5511966665555",
				desired_date: tomorrow,
			}),
		});
		expect(dup.status).toBe(409);

		// prestador vê na lista do dia
		const list = await app.request(`/v1/waitlist?date=${tomorrow}`, {
			headers: h,
		});
		expect(list.status).toBe(200);
		const body = (await list.json()) as {
			waitlist: { client_name: string; status: string }[];
		};
		expect(body.waitlist.some((w) => w.client_name === "Zé Espera")).toBe(true);

		// validações 400
		const badPhone = await app.request(`/v1/p/${slug}/waitlist`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "X",
				phone: "119999",
				desired_date: tomorrow,
			}),
		});
		expect(badPhone.status).toBe(400);
	});

	it("prestador marca notified; slug inválido → 404", async () => {
		const { h, slug } = await setup();
		const badSlug = await app.request("/v1/p/nao-existe-xyz/waitlist", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "X",
				phone: "+5511966665555",
				desired_date: "2026-12-25",
			}),
		});
		expect(badSlug.status).toBe(404);

		// entra na lista do business dele e marca como notified
		const day = "2026-12-25";
		const ins = await app.request(`/v1/p/${slug}/waitlist`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "Maria Lista",
				phone: "+5511955554444",
				desired_date: day,
			}),
		});
		expect(ins.status).toBe(201);
		const list = await app.request(`/v1/waitlist?date=${day}`, { headers: h });
		const body = (await list.json()) as { waitlist: { id: string }[] };
		const entryId = body.waitlist[0]!.id;
		const patch = await app.request(`/v1/waitlist/${entryId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "notified" }),
		});
		expect(patch.status).toBe(200);
	});

	it("cancelar appointment com waitlist no dia → push pro prestador", async () => {
		const { h, slug, bizId } = await setup();
		const day = new Date(Date.now() + 7 * 86_400_000);
		const dateStr = day.toISOString().slice(0, 10);
		// cliente na espera do dia
		await app.request(`/v1/p/${slug}/waitlist`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "Cli Espera",
				phone: "+5511944443333",
				desired_date: dateStr,
			}),
		});
		// appointment confirmado nesse dia
		const svc = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Corte W",
				duration_min: 30,
				price_cents: 5000,
			}),
		});
		const svcBody = (await svc.json()) as { id: string };
		const cli = await sql`
      INSERT INTO clients (business_id, name, phone_e164) VALUES (${bizId}, 'Cli Vaga', '+5511933332222') RETURNING id`;
		const cliId = (cli[0] as { id: string }).id;
		const u = h.Authorization.slice("Bearer ".length);
		const appt = await sql`
      INSERT INTO appointments (business_id, client_id, service_id, user_id, starts_at, ends_at, status)
      VALUES (${bizId}, ${cliId}, ${svcBody.id}, (SELECT id FROM users WHERE firebase_uid = ${u}),
        ${day.toISOString()}, ${new Date(day.getTime() + 3_600_000).toISOString()}, 'confirmed')
      RETURNING id`;
		const apptId = (appt[0] as { id: string }).id;
		sendMock.mockClear();

		// token de device pra push chegar
		await app.request("/v1/devices", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				fcmToken: `fcm-wait-${apptId}`,
				platform: "android",
			}),
		});

		const cancel = await app.request(`/v1/appointments/${apptId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "canceled" }),
		});
		expect(cancel.status).toBe(200);
		// cancelamento feito pelo prestador não gera push próprio; o push
		// esperado é o da vaga-aberta (waitlist)
		await new Promise((r) => setTimeout(r, 300));
		const titles = sendMock.mock.calls.map(
			(c) =>
				(c as unknown[])[0] as
					| { notification?: { title?: string } }
					| undefined,
		);
		expect(titles.map((t) => t?.notification?.title)).toContain(
			"Vaga abriu — lista de espera",
		);
	});
});

describe("F5 waitlist — branches defensivas do PATCH", () => {
	it("id não-uuid → 400; status inválido → 400; id de outro business → 404", async () => {
		const { h, slug } = await setup();
		const badId = await app.request("/v1/waitlist/nao-uuid", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "notified" }),
		});
		expect(badId.status).toBe(400);

		const insB = await app.request(`/v1/p/${slug}/waitlist`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "B",
				phone: "+5511911112222",
				desired_date: "2026-11-05",
			}),
		});
		expect(insB.status).toBe(201);
		const list = await app.request(`/v1/waitlist?date=2026-11-05`, {
			headers: h,
		});
		const body = (await list.json()) as { waitlist: { id: string }[] };

		const entryId = body.waitlist[0]!.id;

		const badStatus = await app.request(`/v1/waitlist/${entryId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "qualquer" }),
		});
		expect(badStatus.status).toBe(400);

		// outro prestador não vê nem altera
		const h2 = authed(uid());
		await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h2 },
			body: JSON.stringify({ name: `Pro Wait ${Date.now()}-${seq++}` }),
		});
		const res2 = await app.request(`/v1/waitlist/${entryId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h2 },
			body: JSON.stringify({ status: "served" }),
		});
		expect(res2.status).toBe(404);

		// body quebrado → 400 (status undefined)
		const badBody = await app.request(`/v1/waitlist/${entryId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: "quebrado{",
		});
		expect(badBody.status).toBe(400);
	});
});

describe("F5 waitlist — validações de entrada", () => {
	it("client_name vazio, phone ruim e date inválida → 400; GET sem date → 400", async () => {
		const { h, slug } = await setup();
		const badName = await app.request(`/v1/p/${slug}/waitlist`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "",
				phone: "+5511966665555",
				desired_date: "2026-12-25",
			}),
		});
		expect(badName.status).toBe(400);
		const badDate = await app.request(`/v1/p/${slug}/waitlist`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "Zé",
				phone: "+5511966665555",
				desired_date: "25/12",
			}),
		});
		expect(badDate.status).toBe(400);
		const noDate = await app.request("/v1/waitlist", { headers: h });
		expect(noDate.status).toBe(400);
	});
});

describe("F5 waitlist — POST público com body quebrado", () => {
	it("JSON inválido → 400 (client_name vazio)", async () => {
		const { slug } = await setup();
		const res = await app.request(`/v1/p/${slug}/waitlist`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "quebrado{",
		});
		expect(res.status).toBe(400);
	});
});
