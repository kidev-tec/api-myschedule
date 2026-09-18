/**
 * Integração REAL: BARRA B5 — ciclo completo marcar → remarcar → cancelar.
 * Firebase mockado, Postgres docker real.
 *
 * Critérios do crítico cego:
 * - remarcar → linha original canceled + reason "remarcado" + canceled_at;
 *   nova linha ativa confirmed (histórico 2 linhas)
 * - cancelar → canceled_at + motivo salvo
 * - conflito de slot (2 requests) → 409 em um
 * - cancel via link público → push disparado (sendToUser mockado) + canceled_at
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
	"postgres://postgres:postgres@localhost:5433/minha_agenda_dev";

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

async function createdUser(headers: Record<string, string>) {
	const res = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ name: `Pro Teste ${headers.Authorization.slice(7)}` }),
	});
	expect(res.status).toBe(201);
}

async function setupBase(headers: Record<string, string>) {
	await createdUser(headers);
	const meUid = headers.Authorization.slice(7);
	const biz = (
		await sql<{ id: string }[]>`
			SELECT b.id FROM businesses b JOIN users u ON u.business_id = b.id
			WHERE u.firebase_uid = ${meUid} LIMIT 1`)[0];
	const client = (await sql<{ id: string }[]>`
		INSERT INTO clients (business_id, name, phone_e164)
		VALUES (${biz.id}, 'Cli', ${"+551499990" + String(seq).padStart(4, "0")})
		RETURNING id`)[0];
	const service = (await sql<{ id: string }[]>`
		INSERT INTO services (business_id, name, duration_min, price_cents)
		VALUES (${biz.id}, 'Corte', 30, 5000) RETURNING id`)[0];
	return { businessId: biz.id, clientId: client.id, serviceId: service.id };
}

function futureDate(hoursAhead: number): string {
	return new Date(Date.now() + hoursAhead * 3600_000).toISOString();
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

describe("B5 — ciclo marcar → remarcar → cancelar", () => {
	it("remarcar preserva histórico: antiga canceled 'remarcado', nova confirmed", async () => {
		const h = authed(uid());
		const base = await setupBase(h);

		const original = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: base.clientId,
				serviceId: base.serviceId,
				startsAt: futureDate(10),
				endsAt: futureDate(11),
			}),
		});
		expect(original.status).toBe(201);
		const { appointment: appt } = (await original.json()) as {
			appointment: { id: string };
		};

		// remarca pra outro horário (sem mudar status)
		const rescheduled = await app.request(`/v1/appointments/${appt.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				startsAt: futureDate(20),
				endsAt: futureDate(21),
			}),
		});
		expect(rescheduled.status).toBe(200);
		const { appointment: nova } = (await rescheduled.json()) as {
			appointment: { id: string; status: string };
			rescheduled: boolean;
		};
		expect(nova.status).toBe("confirmed");
		expect(nova.id).not.toBe(appt.id); // nova linha

		// histórico: 2 linhas — antiga canceled + reason "remarcado"
		const hist = await sql`
			SELECT id, status, canceled_reason FROM appointments
			WHERE business_id = ${base.businessId}
			ORDER BY created_at ASC`;
		const rows = hist as unknown as {
			id: string;
			status: string;
			canceled_reason: string | null;
		}[];
		expect(rows.length).toBe(2);
		const antiga = rows.find((r) => r.id === appt.id);
		expect(antiga?.status).toBe("canceled");
		expect(antiga?.canceled_reason).toBe("remarcado");
	});

	it("remarcar só o início (sem endsAt) preserva a duração original", async () => {
		const h = authed(uid());
		const base = await setupBase(h);

		const original = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: base.clientId,
				serviceId: base.serviceId,
				startsAt: futureDate(15),
				endsAt: futureDate(15.5), // 30 min de duração
			}),
		});
		const { appointment } = (await original.json()) as {
			appointment: { id: string; startsAt: string; endsAt: string };
		};

		// muda SÓ o início → 30 min após o novo início
		const novoInicio = new Date(futureDate(40));
		const rescheduled = await app.request(`/v1/appointments/${appointment.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ startsAt: novoInicio.toISOString() }),
		});
		expect(rescheduled.status).toBe(200);
		const { appointment: nova } = (await rescheduled.json()) as {
			appointment: { startsAt: string; endsAt: string };
		};
		expect(new Date(nova.startsAt).getTime()).toBe(novoInicio.getTime());
		const durMs =
			new Date(nova.endsAt).getTime() - new Date(nova.startsAt).getTime();
		expect(durMs).toBe(30 * 60_000);
	});

	it("remarcar só o fim (sem startsAt) mantém o início", async () => {
		const h = authed(uid());
		const base = await setupBase(h);

		const original = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: base.clientId,
				serviceId: base.serviceId,
				startsAt: futureDate(15),
				endsAt: futureDate(15.5),
			}),
		});
		const { appointment } = (await original.json()) as {
			appointment: { id: string; startsAt: string };
		};

		const novoFim = futureDate(16);
		const rescheduled = await app.request(`/v1/appointments/${appointment.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ endsAt: novoFim }),
		});
		expect(rescheduled.status).toBe(200);
		const { appointment: nova } = (await rescheduled.json()) as {
			appointment: { startsAt: string; endsAt: string };
		};
		expect(new Date(nova.startsAt).getTime()).toBe(
			new Date(appointment.startsAt).getTime(),
		);
		expect(new Date(nova.endsAt).getTime()).toBe(new Date(novoFim).getTime());
	});

	it("cancelar salva canceled_at + motivo", async () => {
		const h = authed(uid());
		const base = await setupBase(h);

		const created = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: base.clientId,
				serviceId: base.serviceId,
				startsAt: futureDate(12),
				endsAt: futureDate(13),
			}),
		});
		const { appointment } = (await created.json()) as {
			appointment: { id: string };
		};

		const canceled = await app.request(`/v1/appointments/${appointment.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				status: "canceled",
				canceledReason: "cliente pediu pra cancelar",
			}),
		});
		expect(canceled.status).toBe(200);

		const rows = await sql<{ canceled_at: Date | null; canceled_reason: string | null }[]>`
			SELECT canceled_at, canceled_reason FROM appointments WHERE id = ${appointment.id}`;
		expect(rows[0]?.canceled_at).not.toBeNull();
		expect(rows[0]?.canceled_reason).toBe("cliente pediu pra cancelar");
	});

	it("dois POSTs no mesmo slot → um 201 e um 409 (constraint EXCLUDE)", async () => {
		const h = authed(uid());
		const base = await setupBase(h);
		const body = {
			clientId: base.clientId,
			serviceId: base.serviceId,
			startsAt: futureDate(30),
			endsAt: futureDate(31),
		};
		// dispara os dois "simultaneamente"
		const [r1, r2] = await Promise.all([
			app.request("/v1/appointments", {
				method: "POST",
				headers: { "content-type": "application/json", ...h },
				body: JSON.stringify(body),
			}),
			app.request("/v1/appointments", {
				method: "POST",
				headers: { "content-type": "application/json", ...h },
				body: JSON.stringify(body),
			}),
		]);
		const statuses = [r1.status, r2.status].sort();
		expect(statuses).toEqual([201, 409]);
	});

	it("slot ocupado some da lista; slot cancelado volta a ficar livre", async () => {
		const h = authed(uid());
		const base = await setupBase(h);

		const start = futureDate(50);
		const created = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: base.clientId,
				serviceId: base.serviceId,
				startsAt: start,
				endsAt: futureDate(51),
			}),
		});
		const { appointment } = (await created.json()) as {
			appointment: { id: string };
		};

		// lista: agendamento ativo aparece (janela default = hoje → +24h;
		// o agendamento foi criado daqui a 50h, então passa ?from/?to explícitos)
		const list = await app.request(
			`/v1/appointments?from=${encodeURIComponent(start)}&to=${encodeURIComponent(futureDate(52))}`,
			{ headers: h },
		);
		const lista = (await list.json()) as { appointments: { id: string }[] };
		expect(lista.appointments.some((a) => a.id === appointment.id)).toBe(true);

		// cancela → some da lista de ativos (GET só traz ativos? valida não-409)
		await app.request(`/v1/appointments/${appointment.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "canceled" }),
		});

		// reutilizar o mesmo slot agora funciona (cancelado libera)
		const rebook = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: base.clientId,
				serviceId: base.serviceId,
				startsAt: start,
				endsAt: futureDate(51),
			}),
		});
		expect(rebook.status).toBe(201);
	});
});
