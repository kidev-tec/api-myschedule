/**
 * Push de "Novo agendamento" pro prestador quando o cliente agenda pelo
 * link público: horário no fuso do NEGÓCIO (não do servidor, UTC em prod)
 * e dados pro app atualizar a agenda.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
const sendToUserMock = vi.hoisted(() =>
	vi.fn(
		async (
			_db: string,
			_userId: string,
			_title: string,
			_body: string,
			_data?: Record<string, string>,
		) => undefined,
	),
);

vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({
	getApps: vi.fn(() => [{} as never]),
}));
vi.mock("../../src/services/fcm.js", () => ({ sendToUser: sendToUserMock }));

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

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Push%')`;
	await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Push%')`;
	await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Push%')`;
	await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-uid-%')`;
	await sql`DELETE FROM users WHERE email LIKE 'test-uid-%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro Push%'`;
	await sql.end();
});

describe("push de novo agendamento pelo link público", () => {
	it("avisa o prestador com horário no fuso do negócio e dados do agendamento", async () => {
		const u = uid();
		verifyMock.mockImplementation(async () => ({
			uid: u,
			email: `${u}@t.com`,
			name: "Pro",
		}));
		const h = { Authorization: `Bearer ${u}` };
		const sync = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: `Pro Push ${u}` }),
		});
		expect(sync.status).toBe(201);
		const [biz] = await sql<{ id: string; slug: string }[]>`
			SELECT b.id, b.slug FROM businesses b JOIN users us ON us.business_id = b.id
			WHERE us.firebase_uid = ${u}`;
		const [pro] = await sql<{ id: string }[]>`
			SELECT id FROM users WHERE firebase_uid = ${u}`;
		if (!biz || !pro) throw new Error("setup: business/usuário não criado");
		const [svc] = await sql<{ id: string }[]>`
			INSERT INTO services (business_id, name, duration_min, price_cents)
			VALUES (${biz.id}, 'Corte', 30, 5000) RETURNING id`;
		if (!svc) throw new Error("setup: serviço não criado");
		// atende todos os dias o dia inteiro (no fuso do negócio)
		for (let d = 0; d < 7; d++) {
			await sql`INSERT INTO working_hours (user_id, weekday, start_time, end_time)
				VALUES (${pro.id}, ${d}, '00:00', '23:59')`;
		}

		// servidor em UTC (como em produção)
		const tzOriginal = process.env.TZ;
		process.env.TZ = "UTC";
		// amanhã 12:00 UTC = 09:00 em America/Sao_Paulo
		const start = new Date();
		start.setUTCDate(start.getUTCDate() + 1);
		start.setUTCHours(12, 0, 0, 0);
		const res = await app.request(`/p/${biz.slug}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Ana Push",
				phone: "+5514999990099",
				service_id: svc.id,
				starts_at: start.toISOString(),
			}),
		});
		if (tzOriginal === undefined) delete process.env.TZ;
		else process.env.TZ = tzOriginal;
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };

		expect(sendToUserMock).toHaveBeenCalledTimes(1);
		const [, userId, title, body, data] = sendToUserMock.mock.calls[0] ?? [];
		expect(userId).toBe(pro.id);
		expect(title).toBe("Novo agendamento");
		expect(body).toContain("Ana Push");
		expect(body).toContain("09:00");
		expect(body).not.toContain("12:00");
		expect(data).toEqual({
			type: "new_booking",
			appointment_id: id,
			starts_at: start.toISOString(),
		});
	});
});
