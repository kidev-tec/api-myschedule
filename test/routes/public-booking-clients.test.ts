/**
 * Link público × cadastro de clientes: o agendamento online reconhece o
 * cliente pelo celular (com ou sem 55, com máscara) e não duplica; quem não
 * tem cadastro é criado só com nome + celular e marcado origin=public_link.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({ getApps: vi.fn(() => [{} as never]) }));

import { createApp } from "../../src/app.js";
import { phoneDigitsBr, phoneMatchKeys } from "../../src/domain/phone-br.js";
import { resetRateLimit } from "../../src/routes/public-booking.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";
const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

const u = `pubcli-uid-${Date.now() % 100_000}`;
const h = { Authorization: `Bearer ${u}` };
let slug = "";
let businessId = "";
let serviceId = "";

beforeAll(async () => {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: "Pro PubCli" };
	});
	const sync = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({ name: `Pro PubCli ${u}` }),
	});
	const b = ((await sync.json()) as { business: { id: string; slug: string } })
		.business;
	slug = b.slug;
	businessId = b.id;
	const [svc] = await sql<{ id: string }[]>`
    INSERT INTO services (business_id, name, duration_min, price_cents)
    VALUES (${businessId}, 'Corte', 30, 4000) RETURNING id`;
	serviceId = svc?.id ?? "";
	await sql`
    INSERT INTO working_hours (user_id, weekday, start_time, end_time)
    SELECT id, d, '08:00', '20:00' FROM users, generate_series(0, 6) d
    WHERE firebase_uid = ${u}`;
});

afterAll(async () => {
	await sql`DELETE FROM appointments WHERE business_id = ${businessId}`;
	await sql`DELETE FROM clients WHERE business_id = ${businessId}`;
	await sql`DELETE FROM services WHERE business_id = ${businessId}`;
	await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE firebase_uid = ${u})`;
	await sql`DELETE FROM users WHERE firebase_uid = ${u}`;
	await sql`DELETE FROM businesses WHERE id = ${businessId}`;
	await sql.end();
});

let hour = 8;
function book(name: string, phone: string) {
	resetRateLimit();
	const d = new Date();
	d.setDate(d.getDate() + 3);
	d.setHours(hour++, 0, 0, 0);
	return app.request(`/p/${slug}/book`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name,
			phone,
			service_id: serviceId,
			starts_at: d.toISOString(),
		}),
	});
}
const clientOf = async (appointmentId: string) =>
	(
		await sql<
			{ id: string; name: string; phone_e164: string; origin: string }[]
		>`
      SELECT c.id, c.name, c.phone_e164, c.origin FROM appointments a
      JOIN clients c ON c.id = a.client_id WHERE a.id = ${appointmentId}`
	)[0];

describe("phone-br", () => {
	it("normaliza pro padrão do app e gera as chaves de busca", () => {
		expect(phoneDigitsBr("(11) 98765-4321")).toBe("5511987654321");
		expect(phoneDigitsBr("+55 11 3456-7890")).toBe("551134567890");
		expect(phoneDigitsBr("5511987654321")).toBe("5511987654321");
		expect(phoneDigitsBr("123")).toBe("123");
		expect(phoneMatchKeys("(11) 98765-4321")).toEqual([
			"5511987654321",
			"11987654321",
		]);
		expect(phoneMatchKeys("123")).toEqual(["123"]);
	});
});

describe("link público reconhece o cliente pelo celular", () => {
	it("cliente cadastrado pelo app (com 55) é reconhecido pelo celular mascarado", async () => {
		const [existing] = await sql<{ id: string }[]>`
      INSERT INTO clients (business_id, name, phone_e164)
      VALUES (${businessId}, 'Maria do App', '5511987650001') RETURNING id`;
		const res = await book("Mariazinha", "(11) 98765-0001");
		expect(res.status).toBe(201);
		const c = await clientOf(((await res.json()) as { id: string }).id);
		expect(c?.id).toBe(existing?.id);
		expect(c?.name).toBe("Maria do App"); // não troca o nome cadastrado
		expect(c?.origin).toBe("app");
	});

	it("cadastro antigo sem 55 também é reconhecido", async () => {
		const [old] = await sql<{ id: string }[]>`
      INSERT INTO clients (business_id, name, phone_e164)
      VALUES (${businessId}, 'Antigo', '11987650002') RETURNING id`;
		const res = await book("Antigo", "+55 11 98765-0002");
		const c = await clientOf(((await res.json()) as { id: string }).id);
		expect(c?.id).toBe(old?.id);
	});

	it("sem cadastro: cria com nome + celular, origin=public_link, e não duplica", async () => {
		const r1 = await book("Kiki", "(13) 99209-3812");
		const c1 = await clientOf(((await r1.json()) as { id: string }).id);
		expect(c1?.name).toBe("Kiki");
		expect(c1?.phone_e164).toBe("5513992093812");
		expect(c1?.origin).toBe("public_link");

		const r2 = await book("Kiki de novo", "13992093812");
		const c2 = await clientOf(((await r2.json()) as { id: string }).id);
		expect(c2?.id).toBe(c1?.id);

		// o app vê a origem na listagem
		const list = (await (
			await app.request("/v1/clients", { headers: h })
		).json()) as { name: string; origin: string }[];
		expect(list.find((x) => x.name === "Kiki")?.origin).toBe("public_link");
		expect(list.find((x) => x.name === "Maria do App")?.origin).toBe("app");

		// e a agenda traz a origem do cliente em cada agendamento
		const agenda = (await (
			await app.request(
				`/v1/appointments?from=${new Date(Date.now() - 86_400_000).toISOString()}&to=${new Date(Date.now() + 10 * 86_400_000).toISOString()}`,
				{ headers: h },
			)
		).json()) as {
			appointments: { client_name: string; client_origin: string }[];
		};
		expect(
			agenda.appointments.find((a) => a.client_name === "Kiki")?.client_origin,
		).toBe("public_link");
		expect(
			agenda.appointments.find((a) => a.client_name === "Maria do App")
				?.client_origin,
		).toBe("app");
	});

	it("cliente removido (LGPD) não é reaproveitado", async () => {
		await sql`
      INSERT INTO clients (business_id, name, phone_e164, deleted_at)
      VALUES (${businessId}, 'Removido', '5511987650003', now())`;
		const res = await book("Voltou", "(11) 98765-0003");
		const c = await clientOf(((await res.json()) as { id: string }).id);
		expect(c?.name).toBe("Voltou");
		expect(c?.origin).toBe("public_link");
	});
});
