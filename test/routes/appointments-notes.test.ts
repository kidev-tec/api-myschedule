/**
 * Integração REAL: observações do agendamento (`notes`) — texto livre do
 * prestador, visível só pra ele (nunca em rota pública).
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
const sendToUserMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({
	getApps: vi.fn(() => [{} as never]),
}));
vi.mock("../../src/services/fcm.js", () => ({
	sendToUser: sendToUserMock,
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
const uid = () => `test-uid-${Date.now()}-${seq++}`;

function authed(uidValue: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== uidValue) throw new Error("invalid");
		return { uid: uidValue, email: `${uidValue}@t.com`, name: "Pro Teste" };
	});
	return { Authorization: `Bearer ${uidValue}` };
}

async function setupBase(headers: Record<string, string>) {
	const auth = headers.Authorization;
	if (!auth) throw new Error("Authorization ausente");
	const res = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({
			name: `Pro Teste ${auth.slice(7)}`,
		}),
	});
	expect(res.status).toBe(201);
	const meUid = auth.slice(7);
	const biz = (
		await sql<{ id: string }[]>`
			SELECT b.id FROM businesses b JOIN users u ON u.business_id = b.id
			WHERE u.firebase_uid = ${meUid} LIMIT 1`
	)[0];
	if (!biz) throw new Error("business não encontrado");
	const client = (
		await sql<{ id: string }[]>`
		INSERT INTO clients (business_id, name, phone_e164)
		VALUES (${biz.id}, 'Cli', ${`+5511${String(90000000 + seq).slice(0, 8)}`})
		RETURNING id`
	)[0];
	if (!client) throw new Error("client não criado");
	const service = (
		await sql<{ id: string }[]>`
		INSERT INTO services (business_id, name, duration_min, price_cents)
		VALUES (${biz.id}, 'Corte', 30, 5000) RETURNING id`
	)[0];
	if (!service) throw new Error("service não criado");
	return { businessId: biz.id, clientId: client.id, serviceId: service.id };
}

function iso(msFromNow: number): string {
	return new Date(Date.now() + msFromNow).toISOString();
}

async function createAppt(
	h: Record<string, string>,
	base: Awaited<ReturnType<typeof setupBase>>,
	startsAt: string,
) {
	const res = await app.request("/v1/appointments", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({
			clientId: base.clientId,
			serviceId: base.serviceId,
			startsAt,
			endsAt: new Date(new Date(startsAt).getTime() + 1800_000).toISOString(),
		}),
	});
	expect(res.status).toBe(201);
	const { appointment } = (await res.json()) as {
		appointment: { id: string };
	};
	return appointment.id;
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste%')`;
	await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste%')`;
	await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste%')`;
	await sql`DELETE FROM users WHERE email LIKE 'test-uid-%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro Teste%'`;
	await sql.end();
});

async function patch(
	h: Record<string, string>,
	id: string,
	body: Record<string, unknown>,
) {
	return app.request(`/v1/appointments/${id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify(body),
	});
}

async function post(h: Record<string, string>, body: Record<string, unknown>) {
	return app.request("/v1/appointments", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify(body),
	});
}

async function notesOf(id: string) {
	const [row] = await sql<{ notes: string | null }[]>`
		SELECT notes FROM appointments WHERE id = ${id}`;
	return row?.notes;
}

describe("observações do agendamento (notes)", () => {
	it("POST com notes grava (trim) e GET da agenda devolve", async () => {
		const h = authed(uid());
		const base = await setupBase(h);
		const start = iso(3 * 3600_000);
		const res = await post(h, {
			clientId: base.clientId,
			serviceId: base.serviceId,
			startsAt: start,
			endsAt: iso(3 * 3600_000 + 1800_000),
			notes: "  alergia a lâmina  ",
		});
		expect(res.status).toBe(201);
		const { appointment } = (await res.json()) as {
			appointment: { id: string; notes: string };
		};
		expect(appointment.notes).toBe("alergia a lâmina");

		const list = await app.request(
			`/v1/appointments?from=${iso(0)}&to=${iso(24 * 3600_000)}`,
			{ headers: h },
		);
		const { appointments } = (await list.json()) as {
			appointments: { id: string; notes: string | null }[];
		};
		expect(appointments.find((a) => a.id === appointment.id)?.notes).toBe(
			"alergia a lâmina",
		);
	});

	it("POST sem notes ou só espaços → null", async () => {
		const h = authed(uid());
		const base = await setupBase(h);
		const id = await createAppt(h, base, iso(4 * 3600_000));
		expect(await notesOf(id)).toBeNull();

		const res = await post(h, {
			clientId: base.clientId,
			serviceId: base.serviceId,
			startsAt: iso(6 * 3600_000),
			endsAt: iso(6 * 3600_000 + 1800_000),
			notes: "   ",
		});
		const { appointment } = (await res.json()) as {
			appointment: { id: string };
		};
		expect(await notesOf(appointment.id)).toBeNull();
	});

	it.each([
		["não-texto", 123],
		["acima de 1000 caracteres", "x".repeat(1001)],
	])("POST com notes %s → 400", async (_caso, notes) => {
		const h = authed(uid());
		const base = await setupBase(h);
		const res = await post(h, {
			clientId: base.clientId,
			serviceId: base.serviceId,
			startsAt: iso(5 * 3600_000),
			endsAt: iso(5 * 3600_000 + 1800_000),
			notes,
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Observações");
	});

	it("PATCH só notes edita no lugar; vazio ou null apaga", async () => {
		const h = authed(uid());
		const base = await setupBase(h);
		const id = await createAppt(h, base, iso(2 * 3600_000));

		const r1 = await patch(h, id, { notes: "chega 10 min antes" });
		expect(r1.status).toBe(200);
		expect(await notesOf(id)).toBe("chega 10 min antes");

		const r2 = await patch(h, id, { notes: "" });
		expect(r2.status).toBe(200);
		expect(await notesOf(id)).toBeNull();

		await patch(h, id, { notes: "de novo" });
		const r3 = await patch(h, id, { notes: null });
		expect(r3.status).toBe(200);
		expect(await notesOf(id)).toBeNull();
	});

	it("PATCH com notes inválida → 400", async () => {
		const h = authed(uid());
		const base = await setupBase(h);
		const id = await createAppt(h, base, iso(2 * 3600_000));
		const res = await patch(h, id, { notes: ["x"] });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Observações");
	});

	it("remarcar copia as notes pra linha nova (ou usa as enviadas)", async () => {
		const h = authed(uid());
		const base = await setupBase(h);
		const id = await createAppt(h, base, iso(2 * 3600_000));
		await patch(h, id, { notes: "cliente novo" });

		const r1 = await patch(h, id, { startsAt: iso(5 * 3600_000) });
		const { appointment: a1 } = (await r1.json()) as {
			appointment: { id: string; notes: string };
		};
		expect(a1.notes).toBe("cliente novo");

		const r2 = await patch(h, a1.id, {
			startsAt: iso(8 * 3600_000),
			notes: "trocou o horário por telefone",
		});
		const { appointment: a2 } = (await r2.json()) as {
			appointment: { id: string; notes: string };
		};
		expect(a2.notes).toBe("trocou o horário por telefone");
	});
});
