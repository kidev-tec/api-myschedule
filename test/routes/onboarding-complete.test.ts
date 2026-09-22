/**
 * Integração REAL: onboarding server-side (item 1 do feedback 22/09).
 *
 * GET /me passa a devolver `onboarding_complete`: true quando o business
 * tem pelo menos 1 horário de funcionamento E 1 serviço ativo. O app usa
 * isso pra pular o assistente mesmo após desinstalação/troca de celular
 * (o sync sempre grava o nome real do Firebase, então nome não é sinal).
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
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";

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

async function syncUser(headers: Record<string, string>) {
	const auth = headers.Authorization ?? "";
	const uidValue = auth.startsWith("Bearer ")
		? auth.slice("Bearer ".length)
		: auth;
	return app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ name: `Pro Teste ${uidValue}` }),
	});
}

async function idsOf(headers: Record<string, string>) {
	const meUid = headers.Authorization.slice("Bearer ".length);
	const rows = await sql<{
		biz_id: string;
		user_id: string;
		biz_name: string;
	}[]>`
		SELECT b.id as biz_id, u.id as user_id, b.name as biz_name
		FROM businesses b JOIN users u ON u.business_id = b.id
		WHERE u.firebase_uid = ${meUid} LIMIT 1`;
	return rows[0];
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-uid-%')`;
	await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste%')`;
	await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste%')`;
	await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste%')`;
	await sql`DELETE FROM users WHERE email LIKE 'test-uid-%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro Teste%'`;
	await sql.end();
});

describe("GET /me — onboarding_complete (item 1, feedback 22/09)", () => {
	it("sync recém-criado (sem horários nem serviços) → false", async () => {
		const h = authed(uid());
		await syncUser(h);

		const res = await app.request("/v1/me", { headers: h });
		expect(res.status).toBe(200);
		const me = (await res.json()) as { onboarding_complete: boolean };
		expect(me.onboarding_complete).toBe(false);
	});

	it("horário + serviço cadastrados → true", async () => {
		const h = authed(uid());
		await syncUser(h);
		const ids = await idsOf(h);

		await sql`
			INSERT INTO working_hours (user_id, weekday, start_time, end_time)
			VALUES (${ids.user_id}, 1, '09:00', '18:00')`;
		await sql`
			INSERT INTO services (business_id, name, duration_min, price_cents)
			VALUES (${ids.biz_id}, 'Corte', 30, 5000)`;

		const res = await app.request("/v1/me", { headers: h });
		expect(res.status).toBe(200);
		const me = (await res.json()) as { onboarding_complete: boolean };
		expect(me.onboarding_complete).toBe(true);
	});

	it("só horário sem serviço → false (onboarding tem 3 passos)", async () => {
		const h = authed(uid());
		await syncUser(h);
		const ids = await idsOf(h);

		await sql`
			INSERT INTO working_hours (user_id, weekday, start_time, end_time)
			VALUES (${ids.user_id}, 1, '09:00', '18:00')`;

		const res = await app.request("/v1/me", { headers: h });
		const me = (await res.json()) as { onboarding_complete: boolean };
		expect(me.onboarding_complete).toBe(false);
	});

	it("só serviço sem horário → false", async () => {
		const h = authed(uid());
		await syncUser(h);
		const ids = await idsOf(h);

		await sql`
			INSERT INTO services (business_id, name, duration_min, price_cents)
			VALUES (${ids.biz_id}, 'Corte', 30, 5000)`;

		const res = await app.request("/v1/me", { headers: h });
		const me = (await res.json()) as { onboarding_complete: boolean };
		expect(me.onboarding_complete).toBe(false);
	});

	it("serviço arquivado não conta (soft delete)", async () => {
		const h = authed(uid());
		await syncUser(h);
		const ids = await idsOf(h);

		await sql`
			INSERT INTO working_hours (user_id, weekday, start_time, end_time)
			VALUES (${ids.user_id}, 1, '09:00', '18:00')`;
		await sql`
			INSERT INTO services (business_id, name, duration_min, price_cents, archived_at)
			VALUES (${ids.biz_id}, 'Corte', 30, 5000, now())`;

		const res = await app.request("/v1/me", { headers: h });
		const me = (await res.json()) as { onboarding_complete: boolean };
		expect(me.onboarding_complete).toBe(false);
	});
});
