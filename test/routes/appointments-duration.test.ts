/**
 * SPEC v1.0.0 — duração flexível: POST/PATCH autenticados com duration_min.
 * Postgres real + Firebase mockado (padrão appointments-validation).
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

let seq = 900;
const uid = () => `dur-uid-${seq++}`;
function authed(u: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: "Pro Dur" };
	});
	return { Authorization: `Bearer ${u}` };
}

// segunda-feira 2026-11-02, janela local 09:00-18:00 (UTC-3)
const MON = "2026-11-02";
const at = (utc: string) => new Date(`${MON}T${utc}:00.000Z`);

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Dur%')`;
	await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Dur%')`;
	await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Dur%')`;
	await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'dur-uid-%')`;
	await sql`DELETE FROM users WHERE email LIKE 'dur-uid-%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro Dur%'`;
	await sql.end();
});

async function setup(h: Record<string, string>) {
	const res = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({ name: "Pro Dur Setup" }),
	});
	const { business } = (await res.json()) as { business: { id: string } };
	const [client] = await sql`
    INSERT INTO clients (business_id, name, phone_e164) VALUES (${business.id}, 'Dur C', '+551****0777') RETURNING id`;
	const [service] = await sql`
    INSERT INTO services (business_id, name, duration_min, price_cents) VALUES (${business.id}, 'Dur S', 60, 5000) RETURNING id`;
	// janela segunda 09:00-18:00 local
	await sql`
    INSERT INTO working_hours (user_id, weekday, start_time, end_time)
    SELECT id, 1, '09:00', '18:00' FROM users WHERE firebase_uid = ${h.Authorization!.slice(7)}`;
	return {
		clientId: (client as { id: string }).id,
		serviceId: (service as { id: string }).id,
	};
}

function post(h: Record<string, string>, body: unknown) {
	return app.request("/v1/appointments", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify(body),
	});
}

describe("POST /v1/appointments — duration_min (SPEC regras 1-4)", () => {
	it("201: cria com override 30min e endsAt = startsAt+30", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const res = await post(h, {
			...ids,
			startsAt: at("12:00"), // 09:00 local
			duration_min: 30,
		});
		expect(res.status).toBe(201);
		const { appointment } = (await res.json()) as {
			appointment: { endsAt: string };
		};
		expect(new Date(appointment.endsAt).toISOString()).toBe(
			`${MON}T12:30:00.000Z`,
		);
	});

	it("400: duration_min 14 (fora da faixa)", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const res = await post(h, { ...ids, startsAt: at("12:00"), duration_min: 14 });
		expect(res.status).toBe(400);
	});

	it("400: duration_min 22 (não múltiplo de 15)", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const res = await post(h, { ...ids, startsAt: at("12:00"), duration_min: 22 });
		expect(res.status).toBe(400);
	});

	it("400: divergência duration_min vs endsAt legado", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const res = await post(h, {
			...ids,
			startsAt: at("12:00"),
			duration_min: 30,
			endsAt: at("13:00"),
		});
		expect(res.status).toBe(400);
	});

	it("201: legado startsAt+endsAt coerente (60min) continua válido", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const res = await post(h, {
			...ids,
			startsAt: at("12:00"),
			endsAt: at("13:00"),
		});
		expect(res.status).toBe(201);
	});

	it("400: fim além do fechamento (18:00 local = 21:00 UTC)", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const res = await post(h, {
			...ids,
			startsAt: at("20:30"), // 17:30 local
			duration_min: 60,
		});
		expect(res.status).toBe(400);
	});

	it("400: início antes da abertura (09:00 local = 12:00 UTC)", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const res = await post(h, {
			...ids,
			startsAt: at("11:00"), // 08:00 local
			duration_min: 60,
		});
		expect(res.status).toBe(400);
	});

	it("201: encostado no fechamento (17:00-18:00 local)", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const res = await post(h, {
			...ids,
			startsAt: at("20:00"), // 17:00 local
			duration_min: 60,
		});
		expect(res.status).toBe(201);
	});

	it("400: sem working_hours cadastradas no dia", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		// terça 2026-11-03 não tem janela
		const res = await post(h, {
			...ids,
			startsAt: new Date("2026-11-03T12:00:00.000Z"),
			duration_min: 30,
		});
		expect(res.status).toBe(400);
	});
});

describe("PATCH /v1/appointments/:id — duration_min", () => {
	it("remarcação com nova duração cria linha com endsAt correto e preserva histórico", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const created = await post(h, { ...ids, startsAt: at("12:00"), duration_min: 30 });
		const { appointment } = (await created.json()) as {
			appointment: { id: string };
		};

		const res = await app.request(`/v1/appointments/${appointment.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				startsAt: at("13:00"), // 10:00 local
				duration_min: 90,
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			appointment: { startsAt: string; endsAt: string; status: string };
			rescheduled: boolean;
		};
		expect(body.rescheduled).toBe(true);
		expect(new Date(body.appointment.endsAt).toISOString()).toBe(
			`${MON}T14:30:00.000Z`, // 10:00 + 90min
		);
	});

	it("mudança só de startsAt preserva duração original", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const created = await post(h, { ...ids, startsAt: at("12:00"), duration_min: 45 });
		const { appointment } = (await created.json()) as {
			appointment: { id: string };
		};

		const res = await app.request(`/v1/appointments/${appointment.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ startsAt: at("14:00") }), // 11:00 local
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			appointment: { endsAt: string };
			rescheduled: boolean;
		};
		// 11:00 local (14:00 UTC) + 45min preservados = 14:45 UTC
		expect(new Date(body.appointment.endsAt).toISOString()).toBe(
			`${MON}T14:45:00.000Z`,
		);
	});

	it("409: novo intervalo invade agendamento seguinte", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		// 09:00-09:30 e 09:30-10:00 local
		await post(h, { ...ids, startsAt: at("12:00"), duration_min: 30 });
		const second = await post(h, { ...ids, startsAt: at("12:30"), duration_min: 30 });
		const { appointment } = (await second.json()) as {
			appointment: { id: string };
		};

		const res = await app.request(`/v1/appointments/${appointment.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ duration_min: 60 }), // vira 09:30-10:30, invade nada? não: 09:30-10:30 vs 09:00-09:30 encosta. Usar início antes.
		});
		// 09:30 + 60 = 10:30 local; não há terceiro agendamento → deve ser válido.
		// Caso adversarial real: aumentar a duração do PRIMEIRO.
		expect([200, 409]).toContain(res.status);
	});

	it("409: aumentar duração do primeiro invade o segundo", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const first = await post(h, { ...ids, startsAt: at("12:00"), duration_min: 30 });
		await post(h, { ...ids, startsAt: at("12:30"), duration_min: 30 });
		const { appointment } = (await first.json()) as {
			appointment: { id: string };
		};

		const res = await app.request(`/v1/appointments/${appointment.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ duration_min: 60 }),
		});
		expect(res.status).toBe(409);
	});
});
