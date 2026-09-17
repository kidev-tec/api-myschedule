/**
 * RF-B01 — GET /appointments/:id/confirm-link (authed).
 * Retorna o link público de confirmação com token HMAC pro app montar
 * a mensagem do WhatsApp.
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
import { confirmationToken } from "../../src/domain/confirmation-token.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = 0;
const uid = () => `test-uid-clink-${Date.now()}-${seq++}`;

function authed(uidValue: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== uidValue) throw new Error("invalid");
		return { uid: uidValue, email: `${uidValue}@t.com`, name: "Pro CLink" };
	});
	return { Authorization: `Bearer ${uidValue}` };
}

async function one<T>(q: Promise<{ id: string }[]>): Promise<T> {
	const rows = await q;
	return rows[0] as T;
}

describe("RF-B01 — confirm-link (authed)", () => {
	let h: Record<string, string>;
	let businessId: string;
	let slug: string;
	let clientId: string;
	let serviceId: string;
	let apptId: string;
	let startsAt: Date;

	beforeAll(async () => {
		await sql`SELECT 1`;
		h = authed(uid());
		const sync = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro CLink Suite" }),
		});
		expect(sync.status).toBe(201);
		const body = (await sync.json()) as {
			business: { id: string; slug: string };
		};
		businessId = body.business.id;
		slug = body.business.slug;

		clientId = (
			await one<{ id: string }>(sql`
			INSERT INTO clients (business_id, name, phone_e164)
			VALUES (${businessId}, 'CLink Fake', '+5511999990003') RETURNING id`)
		).id;
		serviceId = (
			await one<{ id: string }>(sql`
			INSERT INTO services (business_id, name, duration_min, price_cents)
			VALUES (${businessId}, 'Corte CLink', 30, 5000) RETURNING id`)
		).id;

		const pro = await one<{ id: string }>(sql`
			SELECT id FROM users WHERE business_id = ${businessId} LIMIT 1`);
		startsAt = new Date(Date.now() + 48 * 3600_000);
		const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
		apptId = (
			await one<{ id: string }>(sql`
			INSERT INTO appointments (business_id, client_id, service_id, user_id, starts_at, ends_at, status, source)
			VALUES (${businessId}, ${clientId}, ${serviceId}, ${pro.id}, ${startsAt}, ${endsAt}, 'pending', 'public_link')
			RETURNING id`)
		).id;
	});

	afterAll(async () => {
		await sql`DELETE FROM appointments WHERE business_id = ${businessId}`;
		await sql`DELETE FROM clients WHERE business_id = ${businessId}`;
		await sql`DELETE FROM services WHERE business_id = ${businessId}`;
		await sql`DELETE FROM users WHERE business_id = ${businessId}`;
		await sql`DELETE FROM businesses WHERE id = ${businessId}`;
		await sql.end();
	});

	it("retorna link com token HMAC válido e slug do business", async () => {
		const res = await app.request(`/v1/appointments/${apptId}/confirm-link`, {
			headers: h,
		});
		expect(res.status).toBe(200);
		const { link } = (await res.json()) as { link: string };
		expect(link).toContain(`/p/${slug}/confirm/${apptId}`);
		expect(link).toContain(`token=${confirmationToken(apptId, startsAt)}`);
	});

	it("id inválido → 400; agendamento de outro business → 404", async () => {
		const bad = await app.request("/v1/appointments/xxx/confirm-link", {
			headers: h,
		});
		expect(bad.status).toBe(400);

		// outro business (não vê o appt alheio)
		const h2 = authed(uid());
		const sync2 = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h2 },
			body: JSON.stringify({ name: "Pro CLink Outro" }),
		});
		expect(sync2.status).toBe(201);
		const res = await app.request(`/v1/appointments/${apptId}/confirm-link`, {
			headers: h2,
		});
		expect(res.status).toBe(404);
	});
});
