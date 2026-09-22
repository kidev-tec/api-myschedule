/**
 * F1 — endereço do business: PATCH /me { address }, GET /me retorna,
 * página pública mostra. Integração REAL contra Postgres docker.
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
const uid = () => `test-uid-addr-${Date.now()}-${seq++}`;
function authed(u: string) {
	verifyMock.mockImplementation(async (t: string) => {
		if (t !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: "Pro Addr" };
	});
	return { Authorization: `Bearer ${u}` };
}

async function syncUser(h: Record<string, string>) {
	return app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({ name: `Pro Addr ${Date.now()}-${seq}` }),
	});
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	// ordem FK completa: corrida com outros arquivos exige tentar na ordem
	try {
		await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-uid-addr-%')`;
		await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Addr%')`;
		await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Addr%')`;
		await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Addr%')`;
		await sql`DELETE FROM users WHERE email LIKE 'test-uid-addr-%'`;
		await sql`DELETE FROM businesses WHERE name LIKE 'Pro Addr%'`;
	} catch {
		// registro apagado por outro worker — ok
	}
	await sql.end();
});

describe("F1 endereço do business", () => {
	it("GET /me traz address null antes de cadstrar", async () => {
		const h = authed(uid());
		(await syncUser(h)).status;
		const me = await app.request("/v1/me", { headers: h });
		const body = (await me.json()) as {
			address: Record<string, string | null>;
		};
		expect(body.address).toEqual({
			street: null,
			number: null,
			district: null,
			city: null,
			state: null,
			zip: null,
		});
	});

	it("PATCH /me com address completo salva e GET devolve", async () => {
		const h = authed(uid());
		await syncUser(h);
		const patch = await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				address: {
					street: "Rua das Flores",
					number: "123",
					district: "Centro",
					city: "Jaú",
					state: "SP",
					zip: "17201-000",
				},
			}),
		});
		expect(patch.status).toBe(200);
		const me = await app.request("/v1/me", { headers: h });
		const body = (await me.json()) as {
			address: Record<string, string | null>;
		};
		expect(body.address.city).toBe("Jaú");
		expect(body.address.street).toBe("Rua das Flores");
		expect(body.address.state).toBe("SP");
	});

	it("string vazia limpa o campo", async () => {
		const h = authed(uid());
		await syncUser(h);
		await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ address: { city: "Jaú" } }),
		});
		await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ address: { city: "" } }),
		});
		const me = await app.request("/v1/me", { headers: h });
		const body = (await me.json()) as {
			address: Record<string, string | null>;
		};
		expect(body.address.city).toBeNull();
	});

	it("address com null e logo → cobre branches defensivas", async () => {
		const h = authed(uid());
		await syncUser(h);
		// campo explicitamente null (branch v !== null)
		const res = await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ address: { district: null } }),
		});
		expect(res.status).toBe(200);
		// logo presente (branch logo_url ternário no GET /me) — inserção direta
		const u = h.Authorization.slice("Bearer ".length);
		await sql`
      UPDATE businesses SET logo_data = decode('89504e470d0a1a0a', 'hex'), logo_mime = 'image/png'
      WHERE id = (SELECT business_id FROM users WHERE firebase_uid = ${u})`;
		const me = await app.request("/v1/me", { headers: h });
		const body = (await me.json()) as {
			address: Record<string, string | null>;
			logo_url: string | null;
		};
		expect(body.address.district).toBeNull();
		expect(body.logo_url).not.toBeNull();
	});

	it("onboarding_complete false com serviço mas sem horários (branch wh.n=0)", async () => {
		const h = authed(uid());
		await syncUser(h);
		// serviço sem horários: svc.n > 0, wh.n === 0
		await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Só serviço",
				duration_min: 30,
				price_cents: 1000,
			}),
		});
		const me = await app.request("/v1/me", { headers: h });
		const body = (await me.json()) as { onboarding_complete: boolean };
		expect(body.onboarding_complete).toBe(false);
	});

	it("address objeto vazio → 400 nada para atualizar (sem outros campos)", async () => {
		const h = authed(uid());
		await syncUser(h);
		const res = await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ address: {} }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("nada para atualizar");
	});

	it("400: address não-objeto, campo não-string ou excedendo limite", async () => {
		const h = authed(uid());
		await syncUser(h);
		const notObj = await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ address: "Rua X" }),
		});
		expect(notObj.status).toBe(400);
		const notStr = await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ address: { city: 42 } }),
		});
		expect(notStr.status).toBe(400);
		const tooLong = await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ address: { state: "SPE" } }),
		});
		expect(tooLong.status).toBe(400);
	});

	it("página pública retorna address do business", async () => {
		const h = authed(uid());
		await syncUser(h);
		await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				address: {
					street: "Av. Paulista",
					number: "1000",
					city: "São Paulo",
					state: "SP",
				},
			}),
		});
		// slug do business pra URL pública
		const rows = await sql`
      SELECT b.slug FROM businesses b JOIN users u ON u.business_id = b.id
      WHERE u.firebase_uid = ${h.Authorization.slice("Bearer ".length)}`;
		const slug = (rows[0] as { slug: string }).slug;
		// INFO é o JSON que a página pública carrega (renderForm usa INFO.business.address)
		const info = await app.request(`/p/${slug}/info`);
		expect(info.status).toBe(200);
		const body = (await info.json()) as {
			business: { address: Record<string, string | null> };
		};
		expect(body.business.address.street).toBe("Av. Paulista");
		expect(body.business.address.city).toBe("São Paulo");
	});
});
