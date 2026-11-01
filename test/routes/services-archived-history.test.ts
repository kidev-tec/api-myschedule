/**
 * Excluir serviço = arquivar: some da escolha (lista, link público, novos
 * agendamentos), mas tudo que já usou o serviço continua mostrando ele
 * (agenda, histórico do cliente) e pode ser remarcado.
 */
import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({ getApps: vi.fn(() => [{} as never]) }));

import { createApp } from "../../src/app.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";
const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = Date.now() % 100_000;
const uid = () => `arch-uid-${seq++}`;
function authed(u: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: "Pro Arch" };
	});
	return { Authorization: `Bearer ${u}` };
}

// segunda-feira 2026-11-02, janela local 09:00-18:00 (UTC-3)
const at = (utc: string) => `2026-11-02T${utc}:00.000Z`;

afterAll(async () => {
	const ids = await sql<
		{ business_id: string }[]
	>`SELECT business_id FROM users WHERE email LIKE 'arch-uid-%'`;
	for (const { business_id } of ids) {
		await sql`DELETE FROM appointments WHERE business_id = ${business_id}`;
		await sql`DELETE FROM clients WHERE business_id = ${business_id}`;
		await sql`DELETE FROM services WHERE business_id = ${business_id}`;
	}
	await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'arch-uid-%')`;
	await sql`DELETE FROM users WHERE email LIKE 'arch-uid-%'`;
	for (const { business_id } of ids) {
		await sql`DELETE FROM businesses WHERE id = ${business_id}`;
	}
	await sql.end();
});

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

describe("excluir serviço preserva o histórico", () => {
	it("some da escolha, fica onde já foi usado e ainda remarca", async () => {
		const h = authed(uid());
		const sync = await req(h, "POST", "/v1/auth/sync", {
			name: `Pro Arch ${seq}`,
		});
		const { business } = (await sync.json()) as {
			business: { id: string; slug: string };
		};
		await sql`
      INSERT INTO working_hours (user_id, weekday, start_time, end_time)
      SELECT id, 1, '09:00', '18:00' FROM users WHERE firebase_uid = ${h.Authorization?.slice(7) ?? ""}`;
		const [client] = await sql<{ id: string }[]>`
      INSERT INTO clients (business_id, name, phone_e164)
      VALUES (${business.id}, 'Cli Arch', ${`+55119${String(seq).padStart(8, "0")}`}) RETURNING id`;
		const svc = (await (
			await req(h, "POST", "/v1/services", {
				name: "Depilação",
				duration_min: 70,
				price_cents: 15000,
			})
		).json()) as { id: string };
		const ids = { clientId: client?.id, serviceId: svc.id };

		const created = (await (
			await req(h, "POST", "/v1/appointments", {
				...ids,
				startsAt: at("12:00"),
				duration_min: 70,
			})
		).json()) as { appointment: { id: string } };

		// exclui (arquiva)
		expect((await req(h, "DELETE", `/v1/services/${svc.id}`)).status).toBe(200);

		// 1. não aparece mais pra escolher: lista, link público
		const list = (await (await req(h, "GET", "/v1/services")).json()) as {
			id: string;
		}[];
		expect(list.some((s) => s.id === svc.id)).toBe(false);
		const info = (await (
			await app.request(`/p/${business.slug}/info`)
		).json()) as { services: { id: string }[] };
		expect(info.services.some((s) => s.id === svc.id)).toBe(false);

		// 2. novo agendamento com ele é recusado com mensagem clara
		const novo = await req(h, "POST", "/v1/appointments", {
			...ids,
			startsAt: at("16:00"),
			duration_min: 70,
		});
		expect(novo.status).toBe(400);
		expect(((await novo.json()) as { error: string }).error).toContain(
			"foi excluído",
		);

		// 3. o que já usou continua mostrando o serviço
		const agenda = (await (
			await req(
				h,
				"GET",
				`/v1/appointments?from=${at("00:00")}&to=${at("23:59")}`,
			)
		).json()) as { appointments: { id: string; service_name: string }[] };
		expect(
			agenda.appointments.find((a) => a.id === created.appointment.id)
				?.service_name,
		).toBe("Depilação");
		const hist = (await (
			await req(h, "GET", `/v1/clients/${client?.id}/history`)
		).json()) as { recent: { service_name: string }[] };
		expect(hist.recent[0]?.service_name).toBe("Depilação");

		// 4. e o agendamento antigo pode ser remarcado (mantém o serviço)
		const moved = await req(
			h,
			"PATCH",
			`/v1/appointments/${created.appointment.id}`,
			{ startsAt: at("14:00") },
		);
		expect(moved.status).toBe(200);
		const m = (await moved.json()) as { appointment: { serviceId: string } };
		expect(m.appointment.serviceId).toBe(svc.id);
	});
});
