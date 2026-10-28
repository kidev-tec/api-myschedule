/**
 * GET /appointments/:id — detalhe com starts_at_local no fuso do negócio.
 * Fix fuso: mensagem de remarcação não pode depender do fuso do
 * dispositivo nem do servidor. Postgres real + Firebase mockado.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({ getApps: vi.fn(() => [{} as never]) }));

import { createApp } from "../../src/app.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:***@localhost:5433/minha_agenda_dev";
const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = 700;
const uid = () => `tz-uid-${seq++}`;
function authed(u: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: "Pro TZ" };
	});
	return { Authorization: `Bearer ${u}`, "content-type": "application/json" };
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro TZ%')`;
	await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro TZ%')`;
	await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro TZ%')`;
	await sql`DELETE FROM users WHERE email LIKE 'tz-uid-%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro TZ%'`;
	await sql.end();
});

describe("GET /v1/appointments/:id (starts_at_local no fuso do negócio)", () => {
	it("retorna starts_at_local no timezone do business mesmo com servidor em UTC", async () => {
		const prevTz = process.env.TZ;
		process.env.TZ = "UTC";
		try {
			const h = authed(uid());
			const sync = await app.request("/v1/auth/sync", {
				method: "POST",
				headers: h,
				body: JSON.stringify({ name: "Pro TZ Detalhe" }),
			});
			const { business } = (await sync.json()) as {
				business: { id: string };
			};
			const [client] = await sql`
				INSERT INTO clients (business_id, name, phone_e164) VALUES (${business.id}, 'Cli TZ', '+551****9999') RETURNING id`;
			const [service] = await sql`
				INSERT INTO services (business_id, name, duration_min, price_cents) VALUES (${business.id}, 'Corte TZ', 30, 3000) RETURNING id`;
			const bearer = h.Authorization.slice("Bearer ".length);
			const [user] = await sql`
				SELECT id FROM users WHERE firebase_uid = ${bearer}`;
			// 12:00 UTC = 09:00 America/Sao_Paulo
			const start = new Date();
			start.setUTCHours(12, 0, 0, 0);
			const [appt] = await sql`
				INSERT INTO appointments (business_id, client_id, service_id, user_id, starts_at, ends_at, status)
				VALUES (${business.id}, ${client.id}, ${service.id}, ${user.id},
					${start.toISOString()}, ${new Date(start.getTime() + 1800_000).toISOString()}, 'confirmed')
				RETURNING id`;

			const res = await app.request(`/v1/appointments/${appt.id}`, {
				headers: h,
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				appointment: {
					id: string;
					starts_at: string;
					starts_at_local: string;
				};
			};
			expect(body.appointment.id).toBe(appt.id);
			// 12:00 UTC → "09:00" no fuso do negócio, não "12:00" do servidor UTC
			expect(body.appointment.starts_at_local).toContain("09:00");
			expect(body.appointment.starts_at_local).not.toContain("12:00");
		} finally {
			process.env.TZ = prevTz;
		}
	});

	it("404 para id inexistente", async () => {
		const h = authed(uid());
		const sync = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: h,
			body: JSON.stringify({ name: "Pro TZ 404" }),
		});
		expect([200, 201]).toContain(sync.status);
		const notFound = await app.request(
			"/v1/appointments/00000000-0000-0000-0000-000000000000",
			{ headers: h },
		);
		expect(notFound.status).toBe(404);
	});
});
