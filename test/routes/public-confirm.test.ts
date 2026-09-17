/**
 * RF-B02..B04 — Confirmação de presença do cliente via link público.
 * GET /p/:slug/confirm/:appointmentId?token=HMAC(id+startsAt)
 * - token válido: "Vou comparecer" → confirmed; "Não posso" → canceled
 * - idempotente: 2ª chamada não quebra (200)
 * - token inválido → 403
 * Mesmo padrão de public-booking.test.ts: Postgres real, Firebase mockado.
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
const uid = () => `test-uid-confirm-${Date.now()}-${seq++}`;

function authed(uidValue: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== uidValue) throw new Error("invalid");
		return { uid: uidValue, email: `${uidValue}@t.com`, name: "Pro Confirm" };
	});
	return { Authorization: `Bearer ${uidValue}` };
}

async function one<T>(q: Promise<{ id: string }[]>): Promise<T> {
	const rows = await q;
	return rows[0] as T;
}

/** Amanhã 09:00 — horário futuro válido pra confirmação. */
const when = () => {
	const d = new Date();
	d.setDate(d.getDate() + 1);
	d.setHours(9, 0, 0, 0);
	return d;
};

describe("RF-B — confirmação do cliente via link (token HMAC)", () => {
	let h: Record<string, string>;
	let slug: string;
	let clientId: string;
	let serviceId: string;
	let professionalId: string;

	beforeAll(async () => {
		await sql`SELECT 1`;
		h = authed(uid());
		const sync = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro Confirm Suite" }),
		});
		expect(sync.status).toBe(201);
		const body = (await sync.json()) as {
			business: { id: string; slug: string };
		};
		slug = body.business.slug;
		professionalId = (
			await one<{ id: string }>(sql`
				SELECT id FROM users WHERE business_id = ${body.business.id} LIMIT 1`)
		).id;

		clientId = (
			await one<{ id: string }>(sql`
			INSERT INTO clients (business_id, name, phone_e164)
			VALUES (${body.business.id}, 'Confirm Fake', '+5511999990002') RETURNING id`)
		).id;
		serviceId = (
			await one<{ id: string }>(sql`
			INSERT INTO services (business_id, name, duration_min, price_cents)
			VALUES (${body.business.id}, 'Corte Confirm', 30, 5000) RETURNING id`)
		).id;
	});

	afterAll(async () => {
		await sql`DELETE FROM appointments WHERE client_id = ${clientId}`;
		await sql`DELETE FROM clients WHERE id = ${clientId}`;
		await sql`DELETE FROM services WHERE id = ${serviceId}`;
		await sql`DELETE FROM users WHERE business_id IN (SELECT id FROM businesses WHERE name = 'Pro Confirm Suite')`;
		await sql`DELETE FROM businesses WHERE name = 'Pro Confirm Suite'`;
		await sql.end();
	});

	let slotSeq = 0;
	/** cria appointment pending direto no banco (status controlável). Cada
	 *  chamada usa um slot de 10min diferente pra não violar a exclusion constraint. */
	async function createPending(): Promise<{ id: string; startsAt: Date }> {
		const startsAt = new Date(when().getTime() + slotSeq * 60 * 60_000);
		slotSeq++;
		const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
		const row = await one<{ id: string }>(sql`
			INSERT INTO appointments (business_id, client_id, service_id, user_id, starts_at, ends_at, status, source)
			VALUES (
				(SELECT id FROM businesses WHERE name = 'Pro Confirm Suite'),
				${clientId}, ${serviceId}, ${professionalId}, ${startsAt}, ${endsAt}, 'pending', 'public_link'
			) RETURNING id`);
		return { id: row.id, startsAt };
	}

	it("RF-B02: 'Vou comparecer' (decide=confirm) muda pending → confirmed", async () => {
		const appt = await createPending();
		const token = confirmationToken(appt.id, appt.startsAt);

		const res = await app.request(
			`/p/${slug}/confirm/${appt.id}?token=${token}&decide=confirm`,
		);
		expect(res.status).toBe(200);

		const [row] = await sql`
			SELECT status FROM appointments WHERE id = ${appt.id}`;
		expect((row as { status: string }).status).toBe("confirmed");
	});

	it("RF-B02b: 'Não posso mais' (decide=cancel) muda pending → canceled com motivo", async () => {
		const appt = await createPending();
		const token = confirmationToken(appt.id, appt.startsAt);

		const res = await app.request(
			`/p/${slug}/confirm/${appt.id}?token=${token}&decide=cancel`,
		);
		expect(res.status).toBe(200);

		const [row] = await sql`
			SELECT status, canceled_reason FROM appointments WHERE id = ${appt.id}`;
		const r = row as { status: string; canceled_reason: string };
		expect(r.status).toBe("canceled");
		expect(r.canceled_reason).toBe("cliente cancelou via link");
	});

	it("RF-B03: token inválido → 403, status não muda", async () => {
		const appt = await createPending();
		const res = await app.request(
			`/p/${slug}/confirm/${appt.id}?token=INVALIDO&decide=confirm`,
		);
		expect(res.status).toBe(403);
		const [row] = await sql`
			SELECT status FROM appointments WHERE id = ${appt.id}`;
		expect((row as { status: string }).status).toBe("pending");
	});

	it("RF-B04: idempotente — confirmar 2x retorna 200 e não quebra", async () => {
		const appt = await createPending();
		const token = confirmationToken(appt.id, appt.startsAt);
		const url = `/p/${slug}/confirm/${appt.id}?token=${token}&decide=confirm`;

		const r1 = await app.request(url);
		expect(r1.status).toBe(200);
		const r2 = await app.request(url);
		expect(r2.status).toBe(200);
		const [row] = await sql`
			SELECT status FROM appointments WHERE id = ${appt.id}`;
		expect((row as { status: string }).status).toBe("confirmed");
	});

	it("RF-B04b: appointment inexistente → 404", async () => {
		const fakeId = "00000000-0000-4000-8000-000000000000";
		const token = confirmationToken(fakeId, when());
		const res = await app.request(
			`/p/${slug}/confirm/${fakeId}?token=${token}&decide=confirm`,
		);
		expect(res.status).toBe(404);
	});

	it("decide inválido ou ausente → 400", async () => {
		const appt = await createPending();
		const token = confirmationToken(appt.id, appt.startsAt);
		const bad = await app.request(
			`/p/${slug}/confirm/${appt.id}?token=${token}&decide=talvez`,
		);
		expect(bad.status).toBe(400);
		const missing = await app.request(
			`/p/${slug}/confirm/${appt.id}?token=${token}`,
		);
		expect(missing.status).toBe(400);
	});

	it("token ausente → 403", async () => {
		const appt = await createPending();
		const res = await app.request(
			`/p/${slug}/confirm/${appt.id}?decide=confirm`,
		);
		expect(res.status).toBe(403);
	});

	it("slug inexistente → 404", async () => {
		const appt = await createPending();
		const token = confirmationToken(appt.id, appt.startsAt);
		const res = await app.request(
			`/p/slug-fantasma/confirm/${appt.id}?token=${token}&decide=confirm`,
		);
		expect(res.status).toBe(404);
	});
});
