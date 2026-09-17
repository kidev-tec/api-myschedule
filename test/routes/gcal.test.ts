/**
 * RF-08 — Google Calendar: rotas de conexão e espelho.
 *
 * OAuth real não é exercido (Google externo); cobrimos:
 * - auth-url com os parâmetros corretos (client, scope, offline, state=uid)
 * - callback: sem code/state → 400; uid desconhecido → 404; Google 502
 *   (mockado); sucesso → salva refresh_token e responde HTML
 * - status/desconnect ligam e desligam a flag do business
 * - mirrorToCalendar: sem refresh_token → no-op sem erro
 */

import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());

vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({
	getApps: vi.fn(() => [{} as never]),
}));

// fetch global mockado só pros testes que tocam o Google
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import { createApp } from "../../src/app.js";
import { mirrorToCalendar } from "../../src/domain/gcal-mirror.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

function authed(uid: string) {
	return { Authorization: `Bearer ${uid}` };
}

async function setupUser(name: string) {
	const uid = `gcal-${name}-${Date.now()}`;
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== uid) throw new Error("invalid");
		return { uid, email: `${uid}@t.com`, name };
	});
	const res = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...authed(uid) },
		body: JSON.stringify({ name }),
	});
	const body = (await res.json()) as { business?: { slug?: string } };
	return { uid, h: authed(uid), slug: body.business?.slug ?? "" };
}

afterAll(async () => {
	await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro GCal%')`;
	await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro GCal%')`;
	await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro GCal%')`;
	await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gcal-%')`;
	await sql`DELETE FROM users WHERE email LIKE 'gcal-%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro GCal%'`;
	await sql.end();
});

describe("RF-08: Google Calendar", () => {
	it("GET /v1/gcal/auth-url → URL de consent com state=uid", async () => {
		process.env.GCAL_CLIENT_ID = "gcal-client-teste";
		const { uid, h } = await setupUser("Pro GCal URL");
		const res = await app.request("/v1/gcal/auth-url", { headers: h });
		expect(res.status).toBe(200);
		const { url } = (await res.json()) as { url: string };
		const u = new URL(url);
		expect(u.origin + u.pathname).toBe(
			"https://accounts.google.com/o/oauth2/v2/auth",
		);
		expect(u.searchParams.get("response_type")).toBe("code");
		expect(u.searchParams.get("access_type")).toBe("offline");
		expect(u.searchParams.get("state")).toBe(uid);
		expect(u.searchParams.get("scope")).toContain("calendar");
		expect(u.searchParams.get("client_id")).toBe("gcal-client-teste");
	});

	it("callback: sem code → 400; uid desconhecido → 404", async () => {
		expect((await app.request("/v1/gcal/callback")).status).toBe(400);
		expect(
			(await app.request("/v1/gcal/callback?code=x&state=uid-fantasma")).status,
		).toBe(404);
	});

	it("callback: Google recusa code → 502", async () => {
		const { uid } = await setupUser("Pro GCal 502");
		fetchMock.mockResolvedValueOnce(new Response("denied", { status: 400 }));
		const res = await app.request(`/v1/gcal/callback?code=ruim&state=${uid}`);
		expect(res.status).toBe(502);
	});

	it("callback sucesso → refresh_token salvo; status connected; disconnect limpa", async () => {
		const { uid, h } = await setupUser("Pro GCal OK");
		fetchMock.mockResolvedValueOnce(
			Response.json({ refresh_token: "RT-123", access_token: "AT" }),
		);

		const res = await app.request(`/v1/gcal/callback?code=bom&state=${uid}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("conectado");

		// token persistido
		const rows = await sql`
			select gcal_refresh_token, gcal_connected_at
			from businesses where name = 'Pro GCal OK'`;
		expect(rows[0]?.gcal_refresh_token).toBe("RT-123");

		// status reflete
		const status = await app.request("/v1/gcal/status", { headers: h });
		expect(((await status.json()) as { connected: boolean }).connected).toBe(
			true,
		);

		// disconnect limpa
		const off = await app.request("/v1/gcal", {
			method: "DELETE",
			headers: h,
		});
		expect(off.status).toBe(200);
		const rows2 = await sql`
			select gcal_refresh_token from businesses where name = 'Pro GCal OK'`;
		expect(rows2[0]?.gcal_refresh_token).toBeNull();
		const status2 = await app.request("/v1/gcal/status", { headers: h });
		expect(((await status2.json()) as { connected: boolean }).connected).toBe(
			false,
		);
	});

	it("callback sem refresh_token (Google não deu) → 400 com instrução", async () => {
		const { uid } = await setupUser("Pro GCal SemRT");
		fetchMock.mockResolvedValueOnce(Response.json({ access_token: "AT" }));
		const res = await app.request(
			`/v1/gcal/callback?code=sem-refresh&state=${uid}`,
		);
		expect(res.status).toBe(400);
	});

	it("mirrorToCalendar: sem refresh_token → no-op (não lança)", async () => {
		// qualquer id inexistente: o no-op do token ocorre antes do acesso
		await expect(
			mirrorToCalendar(DATABASE_URL, "00000000-0000-4000-8000-000000000009"),
		).resolves.toBeUndefined();
	});

	it("ghost user (uid sem sync) → status 404 e disconnect 404", async () => {
		const ghost = `gcal-ghost-${Date.now()}`;
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== ghost) throw new Error("invalid");
			return { uid: ghost, email: `${ghost}@t.com`, name: "Ghost" };
		});
		const h = { Authorization: `Bearer ${ghost}` };
		expect((await app.request("/v1/gcal/status", { headers: h })).status).toBe(
			404,
		);
		expect(
			(await app.request("/v1/gcal", { method: "DELETE", headers: h })).status,
		).toBe(404);
	});

	it("redirectUri default do env ausente entra na URL", async () => {
		const { uid, h } = await setupUser("Pro GCal DefaultURI");
		delete process.env.GCAL_REDIRECT_URI;
		const res = await app.request("/v1/gcal/auth-url", { headers: h });
		const { url } = (await res.json()) as { url: string };
		expect(new URL(url).searchParams.get("redirect_uri")).toBe(
			`http://localhost:3200/v1/gcal/callback`,
		);
		expect(uid).toBeTruthy();
	});
});
