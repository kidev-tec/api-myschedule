/**
 * Integração REAL: BARRA B4 — working-hours com múltiplos intervalos/dia
 * e validação de overlap. Firebase mockado, Postgres docker real.
 *
 * Cenários:
 * - overlap no mesmo dia → 400 "Horários se sobrepõem na terça-feira"
 * - intervalos que só se encostam (12:00 fim, 12:00 início) → válido
 * - múltiplos intervalos no mesmo dia → persistem e voltam no GET
 * - dia fechado (sem slots) → some do calendário de slots (GET vazio p/ dia)
 * - slots públicos (public booking) respeitam working_hours
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
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = 0;
const uid = () => `test-uid-${Date.now()}-${seq++}`;

function authed(uidValue: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== uidValue) throw new Error("invalid");
		return { uid: uidValue, email: `${uidValue}@t.com`, name: "Pro Teste" };
	});
	return { Authorization: `Bearer ${uidValue}` };
}

async function createdUser(headers: Record<string, string>) {
	const auth = headers.Authorization;
	if (!auth) throw new Error("Authorization ausente");
	const res = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({
			name: `Pro Teste ${auth.slice(7)}`,
		}),
	});
	expect(res.status).toBe(201);
}

async function putHours(
	headers: Record<string, string>,
	slots: { weekday: number; start_minute: number; end_minute: number }[],
) {
	return app.request("/v1/working-hours", {
		method: "PUT",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ slots }),
	});
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste%')`;
	await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-uid-%')`;
	await sql`DELETE FROM users WHERE email LIKE 'test-uid-%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro Teste%'`;
	await sql.end();
});

describe("PUT /v1/working-hours — overlap (B4)", () => {
	it("400 com nome do dia quando intervalos se sobrepõem", async () => {
		const h = authed(uid());
		await createdUser(h);
		// terça-feira (2): 09:00-12:00 e 11:00-18:00 → overlap
		const res = await putHours(h, [
			{ weekday: 2, start_minute: 540, end_minute: 720 },
			{ weekday: 2, start_minute: 660, end_minute: 1080 },
		]);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("terça-feira");
	});

	it("400 em overlap parcial qualquer ordem de envio (normaliza por sort)", async () => {
		const h = authed(uid());
		await createdUser(h);
		// enviado em ordem inversa ainda detecta
		const res = await putHours(h, [
			{ weekday: 4, start_minute: 600, end_minute: 700 },
			{ weekday: 4, start_minute: 540, end_minute: 610 },
		]);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("quinta-feira");
	});

	it("intervalos que se ENCOSTAM são válidos (12:00 fim == 12:00 início)", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await putHours(h, [
			{ weekday: 1, start_minute: 540, end_minute: 720 }, // 09:00-12:00
			{ weekday: 1, start_minute: 720, end_minute: 1080 }, // 12:00-18:00
		]);
		expect(res.status).toBe(200);
		const rows = (await res.json()) as { weekday: number }[];
		expect(rows.length).toBe(2);
	});

	it("intervalos no MESMO dia com gap (manhã + tarde) persistem", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await putHours(h, [
			{ weekday: 3, start_minute: 540, end_minute: 720 }, // 09:00-12:00
			{ weekday: 3, start_minute: 840, end_minute: 1080 }, // 14:00-18:00
		]);
		expect(res.status).toBe(200);
		const rows = (await res.json()) as {
			weekday: number;
			start_time: string;
			end_time: string;
		}[];
		expect(rows.length).toBe(2);
		const starts = rows.map((r) => r.start_time).sort();
		expect(starts).toEqual(["09:00:00", "14:00:00"]);
	});
});

describe("Dia fechado (B4)", () => {
	it("PUT com array vazio remove todos os horários (tudo fechado)", async () => {
		const h = authed(uid());
		await createdUser(h);
		await putHours(h, [{ weekday: 1, start_minute: 540, end_minute: 720 }]);
		const res = await putHours(h, []);
		expect(res.status).toBe(200);
		const rows = (await res.json()) as unknown[];
		expect(rows.length).toBe(0);
	});

	it("dia sem slots não gera horários na consulta pública de slots", async () => {
		const h = authed(uid());
		await createdUser(h);
		// só terça-feira aberta 09:00-12:00
		await putHours(h, [{ weekday: 2, start_minute: 540, end_minute: 720 }]);
		// slug direto do banco (mesma fonte da rota pública)
		const meUid = h.Authorization.slice(7);
		const bizRows = await sql<{ slug: string }[]>`
			SELECT b.slug FROM businesses b
			JOIN users u ON u.business_id = b.id
			WHERE u.firebase_uid = ${meUid} LIMIT 1`;
		const slug = bizRows[0]?.slug;
		expect(slug).toBeTruthy();
		const info = await app.request(`/p/${slug}/info`);
		expect(info.status).toBe(200);
		const infoBody = (await info.json()) as {
			working_hours: { weekday: number }[];
		};
		// só tem horário na terça (2)
		expect(infoBody.working_hours.every((w) => w.weekday === 2)).toBe(true);
	});
});

describe("validações gerais (regressão P4)", () => {
	it("slot com fim <= início → 400", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await putHours(h, [
			{ weekday: 5, start_minute: 720, end_minute: 720 },
		]);
		expect(res.status).toBe(400);
	});

	it("weekday inválido → 400", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await putHours(h, [
			{ weekday: 7, start_minute: 540, end_minute: 720 },
		]);
		expect(res.status).toBe(400);
	});

	it("não-número em start_minute → 400", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await putHours(h, [
			{
				weekday: 5,
				start_minute: "09:00" as unknown as number,
				end_minute: 720,
			},
		]);
		expect(res.status).toBe(400);
	});

	it("body não-JSON → 400", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await app.request("/v1/working-hours", {
			method: "PUT",
			headers: { "content-type": "application/json", ...h },
			body: "{quebrado",
		});
		expect(res.status).toBe(400);
	});

	it("401 sem token (middleware auth)", async () => {
		const res = await app.request("/v1/working-hours", { method: "PUT" });
		expect(res.status).toBe(401);
	});
});
