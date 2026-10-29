/**
 * Integração REAL: cor do tema (identidade visual) do negócio — PATCH/GET /me.
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

describe("cor do tema do negócio (theme_color)", () => {
	async function me(h: Record<string, string>) {
		const r = await app.request("/v1/me", { headers: h });
		return (await r.json()) as { theme_color: string | null };
	}
	async function patch(h: Record<string, string>, body: unknown) {
		return app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify(body),
		});
	}

	it("padrão: null (segue a cor do segmento)", async () => {
		const h = authed(uid());
		await syncUser(h);
		expect((await me(h)).theme_color).toBeNull();
	});

	it("PATCH grava #RRGGBB (normaliza maiúsculo) e GET devolve", async () => {
		const h = authed(uid());
		await syncUser(h);
		const r = await patch(h, { theme_color: "#8b5e34" });
		expect(r.status).toBe(200);
		expect(((await r.json()) as { theme_color: string }).theme_color).toBe(
			"#8B5E34",
		);
		expect((await me(h)).theme_color).toBe("#8B5E34");
	});

	it("null volta pra cor do segmento", async () => {
		const h = authed(uid());
		await syncUser(h);
		await patch(h, { theme_color: "#1976D2" });
		const r = await patch(h, { theme_color: null });
		expect(r.status).toBe(200);
		expect((await me(h)).theme_color).toBeNull();
	});

	it.each(["azul", "#12345", "#GGGGGG", 123])(
		"valor inválido %j → 400",
		async (v) => {
			const h = authed(uid());
			await syncUser(h);
			const r = await patch(h, { theme_color: v });
			expect(r.status).toBe(400);
			expect(((await r.json()) as { error: string }).error).toContain(
				"#RRGGBB",
			);
		},
	);
});
