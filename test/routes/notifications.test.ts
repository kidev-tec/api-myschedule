/**
 * 0024 — central de notificações: notify() guarda + manda push; rotas de
 * lista/contagem/lidas; agendamento pelo link vira notificação; lembrete
 * não vai pra bloqueio de horário.
 */
import postgres from "postgres";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({ getApps: vi.fn(() => [{} as never]) }));
const sendToUserMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/services/fcm.js", () => ({ sendToUser: sendToUserMock }));

import { createApp } from "../../src/app.js";
import { resetRateLimit } from "../../src/routes/public-booking.js";
import { notify } from "../../src/services/notify.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";
const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

const base = `notif-uid-${Date.now() % 100_000}`;
const uids = { a: `${base}-a`, b: `${base}-b`, ghost: `${base}-ghost` };
function as(u: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: "Pro Notif" };
	});
	return { Authorization: `Bearer ${u}` };
}
const req = (u: string, method: string, path: string) =>
	app.request(path, { method, headers: as(u) });

let userA = "";
let userB = "";
let bizA = "";
let slugA = "";

beforeAll(async () => {
	for (const k of ["a", "b"] as const) {
		const res = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...as(uids[k]) },
			body: JSON.stringify({ name: `Pro Notif ${uids[k]}` }),
		});
		const b = ((await res.json()) as { business: { id: string; slug: string } })
			.business;
		if (k === "a") {
			bizA = b.id;
			slugA = b.slug;
		}
	}
	const rows = await sql<{ id: string; firebase_uid: string }[]>`
    SELECT id, firebase_uid FROM users WHERE firebase_uid IN (${uids.a}, ${uids.b})`;
	userA = rows.find((r) => r.firebase_uid === uids.a)?.id ?? "";
	userB = rows.find((r) => r.firebase_uid === uids.b)?.id ?? "";
});

beforeEach(() => sendToUserMock.mockClear());

afterAll(async () => {
	const ids = await sql<
		{ business_id: string }[]
	>`SELECT business_id FROM users WHERE firebase_uid LIKE ${`${base}%`}`;
	for (const { business_id } of ids) {
		await sql`DELETE FROM appointments WHERE business_id = ${business_id}`;
		await sql`DELETE FROM clients WHERE business_id = ${business_id}`;
		await sql`DELETE FROM services WHERE business_id = ${business_id}`;
	}
	await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE firebase_uid LIKE ${`${base}%`})`;
	await sql`DELETE FROM users WHERE firebase_uid LIKE ${`${base}%`}`;
	for (const { business_id } of ids) {
		await sql`DELETE FROM businesses WHERE id = ${business_id}`;
	}
	await sql.end();
});

type N = {
	id: string;
	type: string;
	title: string;
	body: string;
	data: Record<string, string>;
	read: boolean;
	created_at: string;
};

describe("notify()", () => {
	it("guarda a notificação e manda o push com type + notification_id", async () => {
		await notify(DATABASE_URL, {
			userId: userA,
			type: "waitlist",
			title: "Vaga abriu",
			body: "2 clientes na espera",
			data: { date: "2026-11-02" },
		});
		const [row] = await sql<
			{ id: string; business_id: string; type: string }[]
		>`
      SELECT id, business_id, type FROM notifications WHERE user_id = ${userA}
      ORDER BY created_at DESC LIMIT 1`;
		expect(row?.type).toBe("waitlist");
		expect(row?.business_id).toBe(bizA);
		expect(sendToUserMock).toHaveBeenCalledWith(
			DATABASE_URL,
			userA,
			"Vaga abriu",
			"2 clientes na espera",
			{ date: "2026-11-02", type: "waitlist", notification_id: row?.id },
		);
	});

	it("sem dados extras e user inexistente: não guarda, mas tenta o push", async () => {
		await notify(DATABASE_URL, {
			userId: "00000000-0000-4000-8000-000000000000",
			type: "reminder",
			title: "x",
			body: "y",
		});
		expect(sendToUserMock).toHaveBeenCalledWith(
			DATABASE_URL,
			"00000000-0000-4000-8000-000000000000",
			"x",
			"y",
			{ type: "reminder" },
		);
	});

	it("erro no banco: não lança e o push segue", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			notify(DATABASE_URL, {
				userId: "nao-e-uuid", // consulta falha no Postgres
				type: "reminder",
				title: "t",
				body: "b",
			}),
		).resolves.toBeUndefined();
		expect(err).toHaveBeenCalledWith(
			"[notify] não guardou (push segue):",
			expect.anything(),
		);
		expect(sendToUserMock).toHaveBeenCalledTimes(1);
		err.mockRestore();
	});
});

describe("rotas /v1/notifications", () => {
	it("lista (mais novas primeiro), conta não lidas, pagina e marca como lida", async () => {
		await sql`DELETE FROM notifications WHERE user_id = ${userA}`;
		for (let i = 1; i <= 3; i++) {
			await sql`
        INSERT INTO notifications (business_id, user_id, type, title, body, created_at)
        VALUES (${bizA}, ${userA}, 'new_booking', ${`N${i}`}, 'b',
                now() - make_interval(mins => ${10 - i}))`;
		}
		// do outro usuário: nunca aparece pro A
		await notify(DATABASE_URL, {
			userId: userB,
			type: "reminder",
			title: "de B",
			body: "",
		});

		const list = (await (
			await req(uids.a, "GET", "/v1/notifications")
		).json()) as {
			notifications: N[];
			unread: number;
		};
		expect(list.notifications.map((n) => n.title)).toEqual(["N3", "N2", "N1"]);
		expect(list.unread).toBe(3);
		expect(list.notifications[0]?.read).toBe(false);
		expect(list.notifications[0]?.data).toEqual({});

		// paginação: limit + before
		const p1 = (await (
			await req(uids.a, "GET", "/v1/notifications?limit=2")
		).json()) as { notifications: N[] };
		expect(p1.notifications).toHaveLength(2);
		const before = p1.notifications[1]?.created_at ?? "";
		const p2 = (await (
			await req(
				uids.a,
				"GET",
				`/v1/notifications?limit=2&before=${encodeURIComponent(before)}`,
			)
		).json()) as { notifications: N[] };
		expect(p2.notifications.map((n) => n.title)).toEqual(["N1"]);
		// limit inválido cai no padrão; before inválido = 400
		expect(
			(await req(uids.a, "GET", "/v1/notifications?limit=abc")).status,
		).toBe(200);
		expect(
			(await req(uids.a, "GET", "/v1/notifications?before=xx")).status,
		).toBe(400);

		// marca uma como lida
		const id = list.notifications[0]?.id ?? "";
		const r = await req(uids.a, "POST", `/v1/notifications/${id}/read`);
		expect(r.status).toBe(200);
		expect(((await r.json()) as { unread: number }).unread).toBe(2);
		const cnt = (await (
			await req(uids.a, "GET", "/v1/notifications/unread-count")
		).json()) as { unread: number };
		expect(cnt.unread).toBe(2);

		// B não marca a do A; id ruim = 400
		expect(
			(await req(uids.b, "POST", `/v1/notifications/${id}/read`)).status,
		).toBe(404);
		expect((await req(uids.a, "POST", "/v1/notifications/x/read")).status).toBe(
			400,
		);

		// todas como lidas
		const all = await req(uids.a, "POST", "/v1/notifications/read-all");
		expect(((await all.json()) as { unread: number }).unread).toBe(0);
		const after = (await (
			await req(uids.a, "GET", "/v1/notifications")
		).json()) as {
			notifications: N[];
		};
		expect(after.notifications.every((n) => n.read)).toBe(true);
	});

	it("usuário não sincronizado → 404 em todas", async () => {
		for (const [m, p] of [
			["GET", "/v1/notifications"],
			["GET", "/v1/notifications/unread-count"],
			["POST", "/v1/notifications/read-all"],
			["POST", "/v1/notifications/00000000-0000-4000-8000-000000000000/read"],
		] as const) {
			expect((await req(uids.ghost, m, p)).status, `${m} ${p}`).toBe(404);
		}
	});
});

describe("eventos que viram notificação", () => {
	it("agendamento pelo link → notificação new_booking com o agendamento", async () => {
		resetRateLimit();
		const [svc] = await sql<{ id: string }[]>`
      INSERT INTO services (business_id, name, duration_min, price_cents)
      VALUES (${bizA}, 'Barba', 30, 3000) RETURNING id`;
		await sql`
      INSERT INTO working_hours (user_id, weekday, start_time, end_time)
      SELECT ${userA}, d, '08:00', '20:00' FROM generate_series(0, 6) d`;
		const d = new Date();
		d.setDate(d.getDate() + 2);
		d.setHours(10, 0, 0, 0);
		const res = await app.request(`/p/${slugA}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Cliente Link",
				phone: "(11) 98765-1111",
				service_id: svc?.id,
				starts_at: d.toISOString(),
			}),
		});
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };
		await vi.waitFor(async () => {
			const [n] = await sql<
				{
					type: string;
					title: string;
					body: string;
					data: Record<string, string>;
				}[]
			>`
        SELECT type, title, body, data FROM notifications
        WHERE user_id = ${userA} AND type = 'new_booking' AND data->>'appointment_id' = ${id}`;
			expect(n?.title).toBe("Novo agendamento");
			expect(n?.body).toContain("Cliente Link — Barba em");
		});
	});

	it("lembrete não vai pra bloqueio de horário", async () => {
		process.env.INTERNAL_KEY = "test-secret";
		try {
			const [svc] = await sql<{ id: string }[]>`
        SELECT id FROM services WHERE business_id = ${bizA} LIMIT 1`;
			const [cli] = await sql<{ id: string }[]>`
        INSERT INTO clients (business_id, name, phone_e164)
        VALUES (${bizA}, 'Bloq', '') RETURNING id`;
			const inicio = new Date(Date.now() + 3 * 3_600_000);
			await sql`
        INSERT INTO appointments (business_id, client_id, service_id, user_id, starts_at, ends_at, status, source)
        VALUES (${bizA}, ${cli?.id ?? ""}, ${svc?.id ?? ""}, ${userA},
                ${inicio}, ${new Date(inicio.getTime() + 1_800_000)}, 'confirmed', 'block')`;
			await app.request("/v1/internal/appointment-reminders", {
				method: "POST",
				headers: { "x-internal-key": "test-secret" },
			});
			const [n] = await sql<{ n: number }[]>`
        SELECT count(*)::int n FROM notifications
        WHERE user_id = ${userA} AND type = 'reminder'`;
			expect(n?.n).toBe(0);
		} finally {
			delete process.env.INTERNAL_KEY;
		}
	});
});
