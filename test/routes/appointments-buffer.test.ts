/**
 * 0020 — intervalo (folga) entre atendimentos: padrão do negócio em /me,
 * override por agendamento no POST/PATCH, link público e defesa no banco.
 * Postgres real + Firebase mockado (padrão appointments-duration).
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({ getApps: vi.fn(() => [{} as never]) }));

import { createApp } from "../../src/app.js";
import { resetRateLimit } from "../../src/routes/public-booking.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";
const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = Date.now() % 100_000;
const uid = () => `buf-uid-${seq++}`;
function authed(u: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: "Pro Buf" };
	});
	return { Authorization: `Bearer ${u}` };
}

// segunda-feira 2026-11-02, janela local 09:00-18:00 (UTC-3)
const MON = "2026-11-02";
const at = (utc: string) => `${MON}T${utc}:00.000Z`;

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	const biz = sql`SELECT business_id FROM users WHERE email LIKE 'buf-uid-%'`;
	await sql`DELETE FROM appointments WHERE business_id IN (${biz})`;
	await sql`DELETE FROM clients WHERE business_id IN (${biz})`;
	await sql`DELETE FROM services WHERE business_id IN (${biz})`;
	await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'buf-uid-%')`;
	const ids = await sql<
		{ business_id: string }[]
	>`SELECT business_id FROM users WHERE email LIKE 'buf-uid-%'`;
	await sql`DELETE FROM users WHERE email LIKE 'buf-uid-%'`;
	for (const { business_id } of ids) {
		await sql`DELETE FROM businesses WHERE id = ${business_id}`;
	}
	await sql.end();
});

async function setup(h: Record<string, string>, bufferMin = 0) {
	const res = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({ name: `Pro Buf ${seq}` }),
	});
	const { business } = (await res.json()) as {
		business: { id: string; slug: string };
	};
	await sql`UPDATE businesses SET buffer_min = ${bufferMin} WHERE id = ${business.id}`;
	const [client] = await sql`
    INSERT INTO clients (business_id, name, phone_e164) VALUES (${business.id}, 'Buf C', ${`+55119${String(seq).padStart(8, "0")}`}) RETURNING id`;
	const [service] = await sql`
    INSERT INTO services (business_id, name, duration_min, price_cents) VALUES (${business.id}, 'Buf S', 60, 5000) RETURNING id`;
	await sql`
    INSERT INTO working_hours (user_id, weekday, start_time, end_time)
    SELECT id, 1, '09:00', '18:00' FROM users WHERE firebase_uid = ${h.Authorization?.slice(7) ?? ""}`;
	return {
		businessId: business.id,
		slug: business.slug,
		ids: {
			clientId: (client as { id: string }).id,
			serviceId: (service as { id: string }).id,
		},
	};
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

type Appt = {
	id: string;
	startsAt: string;
	endsAt: string;
	bufferMin: number;
};

describe("GET/PATCH /v1/me — buffer_min", () => {
	it("GET devolve o padrão; PATCH só com buffer_min grava", async () => {
		const h = authed(uid());
		await setup(h);
		const before = (await (await req(h, "GET", "/v1/me")).json()) as {
			buffer_min: number;
		};
		expect(before.buffer_min).toBe(0);

		const res = await req(h, "PATCH", "/v1/me", { buffer_min: 15 });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { buffer_min: number }).buffer_min).toBe(15);
		const after = (await (await req(h, "GET", "/v1/me")).json()) as {
			buffer_min: number;
		};
		expect(after.buffer_min).toBe(15);
	});

	it("PATCH sem buffer_min devolve buffer_min null", async () => {
		const h = authed(uid());
		await setup(h);
		const res = await req(h, "PATCH", "/v1/me", { theme_color: "#112233" });
		expect(((await res.json()) as { buffer_min: null }).buffer_min).toBeNull();
	});

	it.each([7, -5, 125, "10", null])("400: buffer_min %p", async (value) => {
		const h = authed(uid());
		await setup(h);
		const res = await req(h, "PATCH", "/v1/me", { buffer_min: value });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"Intervalo entre atendimentos",
		);
	});
});

describe("POST /v1/appointments — buffer_min", () => {
	it("aplica a folga padrão do negócio e devolve no GET", async () => {
		const h = authed(uid());
		const { ids } = await setup(h, 10);
		const first = await req(h, "POST", "/v1/appointments", {
			...ids,
			startsAt: at("12:00"), // 09:00-10:00 local
			duration_min: 60,
		});
		expect(first.status).toBe(201);
		const { appointment } = (await first.json()) as { appointment: Appt };
		expect(appointment.bufferMin).toBe(10);

		// 10:00 local cai na folga do primeiro (até 10:10)
		const clash = await req(h, "POST", "/v1/appointments", {
			...ids,
			startsAt: at("13:00"),
			duration_min: 30,
		});
		expect(clash.status).toBe(409);
		expect(((await clash.json()) as { hint: string }).hint).toContain(
			"intervalo entre atendimentos",
		);

		const ok = await req(h, "POST", "/v1/appointments", {
			...ids,
			startsAt: at("13:10"),
			duration_min: 30,
		});
		expect(ok.status).toBe(201);

		const list = (await (
			await req(
				h,
				"GET",
				`/v1/appointments?from=${at("00:00")}&to=${at("23:59")}`,
			)
		).json()) as { appointments: Appt[] };
		expect(list.appointments.map((a) => a.bufferMin)).toEqual([10, 10]);
	});

	it("override buffer_min 0 encosta no próximo; folga do existente ainda vale", async () => {
		const h = authed(uid());
		const { ids } = await setup(h, 10);
		const first = await req(h, "POST", "/v1/appointments", {
			...ids,
			startsAt: at("12:00"),
			duration_min: 60,
			buffer_min: 0,
		});
		expect(
			((await first.json()) as { appointment: Appt }).appointment.bufferMin,
		).toBe(0);
		const glued = await req(h, "POST", "/v1/appointments", {
			...ids,
			startsAt: at("13:00"),
			duration_min: 30,
			buffer_min: 0,
		});
		expect(glued.status).toBe(201);
	});

	it("409: folga do NOVO invade o seguinte (hint da folga mesmo com buffer 0 no existente)", async () => {
		const h = authed(uid());
		const { ids } = await setup(h);
		const next = await req(h, "POST", "/v1/appointments", {
			...ids,
			startsAt: at("14:00"), // 11:00 local
			duration_min: 30,
		});
		expect(next.status).toBe(201);
		const res = await req(h, "POST", "/v1/appointments", {
			...ids,
			startsAt: at("13:00"),
			duration_min: 55,
			buffer_min: 10, // 10:55 + 10 = 11:05 > 11:00
		});
		expect(res.status).toBe(409);
		expect(((await res.json()) as { hint: string }).hint).toContain(
			"intervalo entre atendimentos",
		);
	});

	it("409: novo sem folga cai na folga do existente", async () => {
		const h = authed(uid());
		const { ids } = await setup(h);
		await req(h, "POST", "/v1/appointments", {
			...ids,
			startsAt: at("12:00"),
			duration_min: 60,
			buffer_min: 15,
		});
		const res = await req(h, "POST", "/v1/appointments", {
			...ids,
			startsAt: at("13:05"),
			duration_min: 30,
			buffer_min: 0,
		});
		expect(res.status).toBe(409);
		expect(((await res.json()) as { hint: string }).hint).toContain(
			"intervalo entre atendimentos",
		);
	});

	it("bloqueio de horário não herda a folga do negócio", async () => {
		const h = authed(uid());
		const { ids } = await setup(h, 20);
		const res = await req(h, "POST", "/v1/appointments", {
			...ids,
			startsAt: at("15:00"),
			duration_min: 60,
			source: "block",
		});
		expect(res.status).toBe(201);
		expect(
			((await res.json()) as { appointment: Appt }).appointment.bufferMin,
		).toBe(0);
	});

	it.each([7, -5, 125, "10"])("400: buffer_min %p", async (value) => {
		const h = authed(uid());
		const { ids } = await setup(h);
		const res = await req(h, "POST", "/v1/appointments", {
			...ids,
			startsAt: at("12:00"),
			duration_min: 30,
			buffer_min: value,
		});
		expect(res.status).toBe(400);
	});
});

describe("PATCH /v1/appointments/:id — buffer_min", () => {
	it("remarcar preserva a folga; buffer_min troca a folga na nova linha", async () => {
		const h = authed(uid());
		const { ids } = await setup(h, 10);
		const created = (await (
			await req(h, "POST", "/v1/appointments", {
				...ids,
				startsAt: at("12:00"),
				duration_min: 30,
			})
		).json()) as { appointment: Appt };

		const moved = await req(
			h,
			"PATCH",
			`/v1/appointments/${created.appointment.id}`,
			{ startsAt: at("15:00") },
		);
		expect(moved.status).toBe(200);
		const m = (await moved.json()) as { appointment: Appt };
		expect(m.appointment.bufferMin).toBe(10);

		const changed = await req(
			h,
			"PATCH",
			`/v1/appointments/${m.appointment.id}`,
			{
				buffer_min: 25,
			},
		);
		expect(changed.status).toBe(200);
		const c2 = (await changed.json()) as {
			appointment: Appt;
			rescheduled: boolean;
		};
		expect(c2.rescheduled).toBe(true);
		expect(c2.appointment.bufferMin).toBe(25);
		expect(c2.appointment.startsAt).toBe(m.appointment.startsAt);
	});

	it("409: remarcar pra dentro da folga de outro", async () => {
		const h = authed(uid());
		const { ids } = await setup(h);
		await req(h, "POST", "/v1/appointments", {
			...ids,
			startsAt: at("12:00"),
			duration_min: 60,
			buffer_min: 10,
		});
		const other = (await (
			await req(h, "POST", "/v1/appointments", {
				...ids,
				startsAt: at("16:00"),
				duration_min: 30,
			})
		).json()) as { appointment: Appt };
		const res = await req(
			h,
			"PATCH",
			`/v1/appointments/${other.appointment.id}`,
			{ startsAt: at("13:05") },
		);
		expect(res.status).toBe(409);
	});

	it("400: buffer_min inválido no PATCH", async () => {
		const h = authed(uid());
		const { ids } = await setup(h);
		const created = (await (
			await req(h, "POST", "/v1/appointments", {
				...ids,
				startsAt: at("12:00"),
				duration_min: 30,
			})
		).json()) as { appointment: Appt };
		const res = await req(
			h,
			"PATCH",
			`/v1/appointments/${created.appointment.id}`,
			{ buffer_min: 3 },
		);
		expect(res.status).toBe(400);
	});
});

describe("banco — exclusion constraint considera a folga", () => {
	it("trigger preenche occupied_until e o EXCLUDE barra overlap na folga", async () => {
		const h = authed(uid());
		const { ids } = await setup(h);
		const created = (await (
			await req(h, "POST", "/v1/appointments", {
				...ids,
				startsAt: at("12:00"),
				duration_min: 60,
				buffer_min: 10,
			})
		).json()) as { appointment: Appt };
		const [row] = await sql<
			{ occupied_until: Date; user_id: string; business_id: string }[]
		>`
      SELECT occupied_until, user_id, business_id FROM appointments WHERE id = ${created.appointment.id}`;
		expect(row?.occupied_until.toISOString()).toBe(at("13:10"));

		await expect(sql`
      INSERT INTO appointments (business_id, client_id, service_id, user_id, starts_at, ends_at, status)
      VALUES (${row?.business_id ?? ""}, ${ids.clientId}, ${ids.serviceId}, ${row?.user_id ?? ""},
              ${at("13:05")}, ${at("13:30")}, 'confirmed')`).rejects.toMatchObject(
			{
				code: "23P01",
			},
		);
	});
});

describe("link público — folga do negócio", () => {
	it("info expõe buffer_min, busy soma a folga e book respeita", async () => {
		resetRateLimit();
		const h = authed(uid());
		const { slug, ids } = await setup(h, 15);
		await req(h, "POST", "/v1/appointments", {
			...ids,
			startsAt: at("12:00"),
			duration_min: 60,
		});

		const info = (await (await app.request(`/p/${slug}/info`)).json()) as {
			business: { buffer_min: number };
		};
		expect(info.business.buffer_min).toBe(15);

		const busy = (await (
			await app.request(`/p/${slug}/busy?date=${MON}`)
		).json()) as { busy: { start: string; end: string }[] };
		expect(busy.busy).toContainEqual({
			start: at("12:00"),
			end: at("13:15"),
		});

		const book = (startsAt: string) =>
			app.request(`/p/${slug}/book`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: "Cli Buf",
					phone: "11988887777",
					service_id: ids.serviceId,
					starts_at: startsAt,
				}),
			});
		expect((await book(at("13:10"))).status).toBe(409);
		// serviço de 60 + folga 15 do NOVO não pode invadir nada depois
		const ok = await book(at("13:20"));
		expect(ok.status).toBe(201);
		const [row] = await sql<{ buffer_min: number }[]>`
      SELECT buffer_min FROM appointments WHERE id = ${((await ok.json()) as { id: string }).id}`;
		expect(row?.buffer_min).toBe(15);
	});
});
