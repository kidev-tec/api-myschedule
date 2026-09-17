/**
 * Integração REAL: rotas auth/sync + appointments contra Postgres docker.
 * Firebase mockado (verifyIdToken controlado por teste) — o banco é real.
 *
 * Isolamento: cada teste usa dados com uid únicos; DB é truncado ao final.
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
import { overlaps } from "../../src/domain/booking.js";

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

/** Insert de teste tipado — evita undefined de noUncheckedIndexedAccess. */
async function one<T>(q: Promise<{ id: string }[]>): Promise<T> {
	const rows = await q;
	return rows[0] as T;
}

async function syncUser(headers: Record<string, string>, name: string) {
	return app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ name }),
	});
}

beforeAll(async () => {
	// garante schema aplicado (migração idempotente via IF NOT EXISTS não cobre ALTER;
	// assumimos 0000_init.sql aplicado — verificado no teste de constraint separado)
	await sql`SELECT 1`;
});

afterAll(async () => {
	// limpeza dos dados de teste — ordem respeitando FKs
	await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste%')`;
	await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste%')`;
	await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste%')`;
	await sql`DELETE FROM users WHERE email LIKE 'test-uid-%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro Teste%'`;
	await sql.end();
});

describe("POST /v1/auth/sync (Postgres real)", () => {
	it("cria business + user no 1º sync (201), com trial de 15 dias", async () => {
		const h = authed(uid());
		const res = await syncUser(h, "Pro Teste Primeiro");
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			user: { firebaseUid: string; role: string };
			business: {
				slug: string;
				subscriptionStatus: string;
				trialEndsAt: string;
			};
		};
		expect(body.user.role).toBe("owner");
		expect(body.business.subscriptionStatus).toBe("trial");
		const trialDays =
			(new Date(body.business.trialEndsAt).getTime() - Date.now()) /
			(1000 * 60 * 60 * 24);
		expect(trialDays).toBeGreaterThan(14);
		expect(trialDays).toBeLessThan(16);
		expect(body.business.slug).toMatch(/^pro-teste-primeiro-/);
	});

	it("é idempotente: 2º sync retorna o mesmo business (200)", async () => {
		const u = uid();
		const h = authed(u);
		await syncUser(h, "Pro Teste Idem");
		const res2 = await syncUser(h, "Pro Teste Idem");
		expect(res2.status).toBe(200);
		const b1 = (await (await syncUser(h, "Pro Teste Idem")).json()) as {
			business: { id: string };
		};
		const b2 = (await res2.json()) as { business: { id: string } };
		expect(b2.business.id).toBe(b1.business.id);
	});

	it("sufixa uid no nome se nome+segmento já existe", async () => {
		const nome = `Pro Teste Clash ${Date.now()}`;
		const first = await syncUser(authed(uid()), nome);
		expect(first.status).toBe(201);
		const second = await syncUser(authed(uid()), nome);
		expect(second.status).toBe(201);
		const body = (await second.json()) as { business: { name: string } };
		expect(body.business.name.startsWith(`${nome} ·`)).toBe(true);
	});

	it("401 sem token", async () => {
		const res = await syncUser({}, "X");
		expect(res.status).toBe(401);
	});
});

describe("POST/GET /v1/appointments (Postgres real, constraint EXCLUDE ativa)", () => {
	it("cria agendamento e lista na agenda do dia", async () => {
		const h = authed(uid());
		const { business } = (await (
			await syncUser(h, "Pro Teste Agenda")
		).json()) as never as {
			user: { id: string };
			business: { id: string };
		};

		// cliente + serviço direto no banco (CRUDs vêm em F1)
		const client = await one<{ id: string }>(sql`
          INSERT INTO clients (business_id, name, phone_e164)
          VALUES (${business.id}, 'Ana', '+5514999990001') RETURNING id`);
		const service = await one<{ id: string }>(sql`
      INSERT INTO services (business_id, name, duration_min, price_cents)
      VALUES (${business.id}, 'Corte', 30, 5000) RETURNING id`);

		const start = new Date(Date.now() + 3600_000);
		const end = new Date(start.getTime() + 3600_000);
		const res = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: client.id,
				serviceId: service.id,
				startsAt: start.toISOString(),
				endsAt: end.toISOString(),
			}),
		});
		expect(res.status).toBe(201);
		const { appointment } = (await res.json()) as {
			appointment: { id: string; status: string };
		};
		expect(appointment.status).toBe("confirmed");

		const list = await app.request("/v1/appointments", { headers: h });
		const body = (await list.json()) as { appointments: { id: string }[] };
		expect(body.appointments.some((a) => a.id === appointment.id)).toBe(true);
	});

	it("rejeita overlap com 409 amigável (defesa domínio)", async () => {
		const h = authed(uid());
		const { business } = (await (
			await syncUser(h, "Pro Teste Overlap")
		).json()) as never as {
			user: { id: string };
			business: { id: string };
		};
		const client = await one<{ id: string }>(sql`
      INSERT INTO clients (business_id, name, phone_e164)
      VALUES (${business.id}, 'Bia', '+5514999990002') RETURNING id`);
		const service = await one<{ id: string }>(sql`
      INSERT INTO services (business_id, name, duration_min, price_cents)
      VALUES (${business.id}, 'Unha', 60, 8000) RETURNING id`);

		const start = new Date(Date.now() + 7200_000);
		const end = new Date(start.getTime() + 3600_000);
		const mk = (s: Date, e: Date) =>
			app.request("/v1/appointments", {
				method: "POST",
				headers: { "content-type": "application/json", ...h },
				body: JSON.stringify({
					clientId: client.id,
					serviceId: service.id,
					startsAt: s.toISOString(),
					endsAt: e.toISOString(),
				}),
			});

		expect((await mk(start, end)).status).toBe(201);
		const conflict = await mk(
			new Date(start.getTime() + 1800_000),
			new Date(end.getTime() + 1800_000),
		);
		expect(conflict.status).toBe(409);
		const body = (await conflict.json()) as { error: string; hint?: string };
		expect(body.error).toBe("conflito de horário");
		expect(body.hint).toBeDefined();
	});

	it("PATCH cancela e libera o slot (cancelado não conflita)", async () => {
		const h = authed(uid());
		const { business } = (await (
			await syncUser(h, "Pro Teste Cancela")
		).json()) as never as {
			business: { id: string };
		};
		const client = await one<{ id: string }>(sql`
      INSERT INTO clients (business_id, name, phone_e164)
      VALUES (${business.id}, 'Cris', '+5514999990003') RETURNING id`);
		const service = await one<{ id: string }>(sql`
      INSERT INTO services (business_id, name, duration_min, price_cents)
      VALUES (${business.id}, 'Sobrancelha', 30, 4000) RETURNING id`);

		const start = new Date(Date.now() + 10_800_000);
		const end = new Date(start.getTime() + 1800_000);
		const res1 = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: client.id,
				serviceId: service.id,
				startsAt: start.toISOString(),
				endsAt: end.toISOString(),
			}),
		});
		const { appointment } = (await res1.json()) as {
			appointment: { id: string };
		};

		const patch = await app.request(`/v1/appointments/${appointment.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				status: "canceled",
				canceledReason: "cliente desistiu",
			}),
		});
		expect(patch.status).toBe(200);

		// mesmo slot agora é criável (cancelado fora da constraint)
		const res2 = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: client.id,
				serviceId: service.id,
				startsAt: start.toISOString(),
				endsAt: end.toISOString(),
			}),
		});
		expect(res2.status).toBe(201);
	});

	it("404 ao cancelar agendamento inexistente", async () => {
		const h = authed(uid());
		await syncUser(h, "Pro Teste 404");
		const res = await app.request(
			`/v1/appointments/00000000-0000-0000-0000-00000000dead`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json", ...h },
				body: JSON.stringify({ status: "canceled" }),
			},
		);
		expect(res.status).toBe(404);
	});

	it("domain overlaps() consistente com constraint do banco (paridade)", () => {
		// sanity: a regra do domínio e a constraint usam a mesma semântica [start,end)
		const s = new Date("2026-09-10T13:00Z");
		const e = new Date("2026-09-10T14:00Z");
		expect(
			overlaps(
				s,
				e,
				new Date("2026-09-10T13:59Z"),
				new Date("2026-09-10T15:00Z"),
			),
		).toBe(true);
		expect(
			overlaps(
				s,
				e,
				new Date("2026-09-10T14:00Z"),
				new Date("2026-09-10T15:00Z"),
			),
		).toBe(false);
	});
});
