/**
 * Integração REAL: valor do atendimento e situação da cobrança
 * (módulo de finanças, TASK-F1-02 — RF-F02, RF-F03).
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
vi.mock("../../src/services/fcm.js", () => ({
	sendToUser: vi.fn(async () => undefined),
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
const uid = () => `price-uid-${Date.now()}-${seq++}`;

function authed(uidValue: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== uidValue) throw new Error("invalid");
		return { uid: uidValue, email: `${uidValue}@t.com`, name: "Pro Preço" };
	});
	return { Authorization: `Bearer ${uidValue}` };
}

type Base = {
	h: Record<string, string>;
	businessId: string;
	userId: string;
	slug: string;
	clientId: string;
	serviceId: string;
};

async function setup(): Promise<Base> {
	const u = uid();
	const h = authed(u);
	const res = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({ name: `Pro Preço ${u}` }),
	});
	expect(res.status).toBe(201);
	const [me] = await sql<
		{ businessId: string; userId: string; slug: string }[]
	>`
    SELECT b.id AS "businessId", u.id AS "userId", b.slug
    FROM businesses b JOIN users u ON u.business_id = b.id
    WHERE u.firebase_uid = ${u}`;
	if (!me) throw new Error("negócio não criado");
	const [client] = await sql<{ id: string }[]>`
    INSERT INTO clients (business_id, name, phone_e164)
    VALUES (${me.businessId}, 'Cli', ${`+55119${String(10000000 + seq).slice(0, 8)}`})
    RETURNING id`;
	const [service] = await sql<{ id: string }[]>`
    INSERT INTO services (business_id, name, duration_min, price_cents)
    VALUES (${me.businessId}, 'Corte', 30, 5000) RETURNING id`;
	await sql`
    INSERT INTO working_hours (user_id, weekday, start_time, end_time)
    VALUES (${me.userId}, 1, '09:00', '18:00')`;
	if (!client || !service) throw new Error("fixtures");
	return { h, ...me, clientId: client.id, serviceId: service.id };
}

const HOUR = 3600_000;
function iso(msFromNow: number): string {
	return new Date(Date.now() + msFromNow).toISOString();
}

/** Segunda-feira (dia com expediente) a 7+ dias, 13:00Z. */
function nextMonday(hourUtc = 13): string {
	const d = new Date();
	d.setUTCHours(hourUtc, 0, 0, 0);
	d.setUTCDate(d.getUTCDate() + 7 + ((8 - d.getUTCDay()) % 7));
	return d.toISOString();
}

function req(
	h: Record<string, string>,
	method: string,
	path: string,
	body?: unknown,
) {
	return app.request(path, {
		method,
		headers: { "content-type": "application/json", ...h },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function createAppt(b: Base, startsAt = iso(48 * HOUR)) {
	const res = await req(b.h, "POST", "/v1/appointments", {
		clientId: b.clientId,
		serviceId: b.serviceId,
		startsAt,
		endsAt: new Date(new Date(startsAt).getTime() + 1800_000).toISOString(),
	});
	expect(res.status).toBe(201);
	return (
		(await res.json()) as { appointment: { id: string; priceCents: number } }
	).appointment;
}

async function pay(
	b: Base,
	appointmentId: string,
	cents: number,
	voided = false,
) {
	await sql`
    INSERT INTO transactions (business_id, type, amount_cents, category, appointment_id, payment_method, voided_at)
    VALUES (${b.businessId}, 'income', ${cents}, 'atendimento', ${appointmentId}, 'pix',
            ${voided ? new Date() : null})`;
}

async function priceOf(id: string) {
	const [r] = await sql<{ price_cents: number }[]>`
    SELECT price_cents FROM appointments WHERE id = ${id}`;
	return r?.price_cents;
}

type ListItem = {
	id: string;
	price_cents: number;
	paid_cents: number;
	balance_cents: number;
	payment_status: string;
	service_price_cents: number;
};
async function listItem(b: Base, id: string, from: string, to: string) {
	const res = await req(
		b.h,
		"GET",
		`/v1/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
	);
	expect(res.status).toBe(200);
	const { appointments } = (await res.json()) as { appointments: ListItem[] };
	return appointments.find((a) => a.id === id);
}

afterAll(async () => {
	const biz = sql`SELECT id FROM businesses WHERE name LIKE 'Pro Preço%'`;
	await sql`DELETE FROM transactions WHERE business_id IN (${biz})`;
	await sql`DELETE FROM appointments WHERE business_id IN (${biz})`;
	await sql`DELETE FROM clients WHERE business_id IN (${biz})`;
	await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'price-uid-%')`;
	await sql`DELETE FROM users WHERE email LIKE 'price-uid-%'`;
	await sql`DELETE FROM services WHERE business_id IN (${biz})`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro Preço%'`;
	await sql.end();
});

describe("RF-F03 — snapshot do preço", () => {
	it("app grava o preço do serviço; mudar o serviço depois não altera", async () => {
		const b = await setup();
		const a = await createAppt(b);
		expect(a.priceCents).toBe(5000);
		await sql`UPDATE services SET price_cents = 9900 WHERE id = ${b.serviceId}`;
		expect(await priceOf(a.id)).toBe(5000);
	});

	it("bloqueio de horário grava 0", async () => {
		const b = await setup();
		const res = await req(b.h, "POST", "/v1/appointments", {
			startsAt: iso(72 * HOUR),
			endsAt: iso(73 * HOUR),
			source: "block",
		});
		expect(res.status).toBe(201);
		const { appointment } = (await res.json()) as {
			appointment: { priceCents: number };
		};
		expect(appointment.priceCents).toBe(0);
	});

	it("link público grava o preço do serviço", async () => {
		const b = await setup();
		const res = await app.request(`/p/${b.slug}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Cli Pub",
				phone: "11977775555",
				service_id: b.serviceId,
				starts_at: nextMonday(),
			}),
		});
		expect(res.status).toBe(201);
		const [row] = await sql<{ price_cents: number }[]>`
      SELECT price_cents FROM appointments
      WHERE business_id = ${b.businessId} AND source = 'public_link'`;
		expect(row?.price_cents).toBe(5000);
	});
});

describe("RF-F03 — PATCH price_cents", () => {
	it("aceita desconto e devolve o valor novo", async () => {
		const b = await setup();
		const a = await createAppt(b);
		const res = await req(b.h, "PATCH", `/v1/appointments/${a.id}`, {
			price_cents: 4000,
		});
		expect(res.status).toBe(200);
		expect(await priceOf(a.id)).toBe(4000);
	});

	it.each([
		["negativo", -1],
		["fracionado", 10.5],
		["texto", "40"],
		["acima do máximo", 100_000_001],
	])("rejeita valor %s com 400", async (_l, value) => {
		const b = await setup();
		const a = await createAppt(b);
		const res = await req(b.h, "PATCH", `/v1/appointments/${a.id}`, {
			price_cents: value,
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe(
			"Valor inválido",
		);
	});

	it("não altera agendamento já pago (422)", async () => {
		const b = await setup();
		const a = await createAppt(b);
		await pay(b, a.id, 5000);
		const res = await req(b.h, "PATCH", `/v1/appointments/${a.id}`, {
			price_cents: 6000,
		});
		expect(res.status).toBe(422);
		expect(((await res.json()) as { error: string }).error).toContain(
			"já está pago",
		);
	});

	it("não aceita valor menor que o já recebido (422)", async () => {
		const b = await setup();
		const a = await createAppt(b);
		await pay(b, a.id, 3000);
		const res = await req(b.h, "PATCH", `/v1/appointments/${a.id}`, {
			price_cents: 2000,
		});
		expect(res.status).toBe(422);
		expect(((await res.json()) as { error: string }).error).toBe(
			"O valor não pode ser menor que o já recebido (R$ 30,00)",
		);
		// igual ao recebido é aceito (vira pago)
		const ok = await req(b.h, "PATCH", `/v1/appointments/${a.id}`, {
			price_cents: 3000,
		});
		expect(ok.status).toBe(200);
	});

	it("bloqueio não tem valor (400)", async () => {
		const b = await setup();
		const res = await req(b.h, "POST", "/v1/appointments", {
			startsAt: iso(80 * HOUR),
			endsAt: iso(81 * HOUR),
			source: "block",
		});
		const { appointment } = (await res.json()) as {
			appointment: { id: string };
		};
		const p = await req(b.h, "PATCH", `/v1/appointments/${appointment.id}`, {
			price_cents: 1000,
		});
		expect(p.status).toBe(400);
		expect(((await p.json()) as { error: string }).error).toBe(
			"Bloqueio de horário não tem valor",
		);
	});
});

describe("RF-F02 — remarcar mantém valor e recebimentos", () => {
	it("nova linha herda price_cents e o sinal; anulado não é movido", async () => {
		const b = await setup();
		const a = await createAppt(b);
		await req(b.h, "PATCH", `/v1/appointments/${a.id}`, { price_cents: 4500 });
		await pay(b, a.id, 2000);
		await pay(b, a.id, 700, true);

		const res = await req(b.h, "PATCH", `/v1/appointments/${a.id}`, {
			startsAt: iso(96 * HOUR),
		});
		expect(res.status).toBe(200);
		const { appointment } = (await res.json()) as {
			appointment: { id: string; priceCents: number };
		};
		expect(appointment.id).not.toBe(a.id);
		expect(appointment.priceCents).toBe(4500);

		const moved = await sql<{ appointment_id: string; voided: boolean }[]>`
      SELECT appointment_id, voided_at IS NOT NULL AS voided
      FROM transactions WHERE business_id = ${b.businessId} ORDER BY amount_cents`;
		expect(moved).toEqual([
			{ appointment_id: a.id, voided: true },
			{ appointment_id: appointment.id, voided: false },
		]);
	});

	it("remarcar enviando price_cents novo usa o valor novo", async () => {
		const b = await setup();
		const a = await createAppt(b);
		const res = await req(b.h, "PATCH", `/v1/appointments/${a.id}`, {
			startsAt: iso(100 * HOUR),
			price_cents: 3900,
		});
		expect(res.status).toBe(200);
		const { appointment } = (await res.json()) as {
			appointment: { priceCents: number };
		};
		expect(appointment.priceCents).toBe(3900);
	});
});

describe("RF-F02 — situação na listagem da agenda", () => {
	it("traz valor, recebido, saldo e situação (anulado não soma)", async () => {
		const b = await setup();
		const start = iso(120 * HOUR);
		const from = iso(119 * HOUR);
		const to = iso(121 * HOUR);
		const a = await createAppt(b, start);

		let item = await listItem(b, a.id, from, to);
		expect(item).toMatchObject({
			price_cents: 5000,
			paid_cents: 0,
			balance_cents: 5000,
			payment_status: "open",
			service_price_cents: 5000,
		});

		await pay(b, a.id, 2000);
		await pay(b, a.id, 1000, true);
		item = await listItem(b, a.id, from, to);
		expect(item).toMatchObject({
			paid_cents: 2000,
			balance_cents: 3000,
			payment_status: "partial",
		});

		await pay(b, a.id, 3000);
		item = await listItem(b, a.id, from, to);
		expect(item).toMatchObject({ balance_cents: 0, payment_status: "paid" });
	});
});
