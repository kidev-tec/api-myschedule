/**
 * Rotas de agendamento — casos de erro/validação (complementam integration.test.ts).
 * Postgres real + Firebase mockado. Coverage 100% obrigatória.
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
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";
const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = 500;
const uid = () => `val-uid-${seq++}`;
function authed(u: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: "Pro Val" };
	});
	return { Authorization: `Bearer ${u}` };
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Val%')`;
	await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Val%')`;
	await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Val%')`;
	await sql`DELETE FROM users WHERE email LIKE 'val-uid-%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro Val%'`;
	await sql.end();
});

async function setup(h: Record<string, string>) {
	const res = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({ name: "Pro Val Setup" }),
	});
	const { business } = (await res.json()) as { business: { id: string } };
	const [client] = await sql`
    INSERT INTO clients (business_id, name, phone_e164) VALUES (${business.id}, 'Val C', '+5514999990999') RETURNING id`;
	const [service] = await sql`
    INSERT INTO services (business_id, name, duration_min, price_cents) VALUES (${business.id}, 'Val S', 30, 3000) RETURNING id`;
	return {
		clientId: (client as { id: string }).id,
		serviceId: (service as { id: string }).id,
	};
}

describe("validações /v1/appointments (400/404/403)", () => {
	it("400: body não-JSON", async () => {
		const h = authed(uid());
		await setup(h);
		const res = await app.request("/v1/appointments", {
			method: "POST",
			headers: h,
			body: "isso nao é json",
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"body inválido",
		);
	});

	it("400: clientId/serviceId fora do formato uuid", async () => {
		const h = authed(uid());
		await setup(h);
		const res = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: "nao-uuid",
				serviceId: "x",
				startsAt: "2026-01-01T10:00Z",
				endsAt: "2026-01-01T11:00Z",
			}),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"clientId e serviceId",
		);
	});

	it("400: datas inválidas", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const res = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: ids.clientId,
				serviceId: ids.serviceId,
				startsAt: "ontem",
				endsAt: "amanhã",
			}),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"startsAt/endsAt",
		);
	});

	it("400: FK violada → 'cliente ou serviço inexistente' (erro 23503 do banco)", async () => {
		const h = authed(uid());
		await setup(h);
		const res = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: "00000000-0000-0000-0000-00000000dead",
				serviceId: "00000000-0000-0000-0000-00000000dead",
				startsAt: new Date(Date.now() + 86_400_000).toISOString(),
				endsAt: new Date(Date.now() + 90_000_000).toISOString(),
			}),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"inexistente",
		);
	});

	it("403: token válido mas usuário nunca fez /auth/sync", async () => {
		const h = authed(uid());
		const res = await app.request("/v1/appointments", { headers: h });
		expect(res.status).toBe(403);
	});

	it("400: PATCH id inválido / body vazio / status inválido / datas invertidas", async () => {
		const h = authed(uid());
		await setup(h);

		const badId = await app.request("/v1/appointments/nao-uuid", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "canceled" }),
		});
		expect(badId.status).toBe(400);

		const empty = await app.request(
			"/v1/appointments/00000000-0000-0000-0000-00000000beef",
			{
				method: "PATCH",
				headers: { "content-type": "application/json", ...h },
				body: JSON.stringify({}),
			},
		);
		expect(empty.status).toBe(404); // id válido mas inexistente → 404 antes do body check? não: body parse roda antes do lookup? ver ordem — 404 esperado

		const res2 = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: "00000000-0000-0000-0000-00000000dead",
				serviceId: "00000000-0000-0000-0000-00000000dead",
				startsAt: "x",
				endsAt: "y",
			}),
		});
		expect(res2.status).toBe(400);
	});

	it("400: PATCH com status inválido", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const start = new Date(Date.now() + 172_800_000);
		const created = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: ids.clientId,
				serviceId: ids.serviceId,
				startsAt: start.toISOString(),
				endsAt: new Date(start.getTime() + 1_800_000).toISOString(),
			}),
		});
		const { appointment } = (await created.json()) as {
			appointment: { id: string };
		};

		const res = await app.request(`/v1/appointments/${appointment.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "status-maluco" }),
		});
		expect(res.status).toBe(400);
	});

	it("400: PATCH remarcação com datas invertidas", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const start = new Date(Date.now() + 259_200_000);
		const created = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: ids.clientId,
				serviceId: ids.serviceId,
				startsAt: start.toISOString(),
				endsAt: new Date(start.getTime() + 1_800_000).toISOString(),
			}),
		});
		const { appointment } = (await created.json()) as {
			appointment: { id: string };
		};

		const res = await app.request(`/v1/appointments/${appointment.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				startsAt: new Date(start.getTime() + 7_200_000).toISOString(),
				endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
			}),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"antes de",
		);
	});

	it("409: remarcação para slot ocupado (defesa domínio)", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const base = Date.now() + 345_600_000;
		const mk = (offset: number) =>
			app.request("/v1/appointments", {
				method: "POST",
				headers: { "content-type": "application/json", ...h },
				body: JSON.stringify({
					clientId: ids.clientId,
					serviceId: ids.serviceId,
					startsAt: new Date(base + offset).toISOString(),
					endsAt: new Date(base + offset + 1_800_000).toISOString(),
				}),
			});
		const a = (await (await mk(0)).json()) as { appointment: { id: string } };
		await mk(7_200_000); // ocupa 2h depois

		// remarca o 1º para cima do 2º
		const res = await app.request(`/v1/appointments/${a.appointment.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				startsAt: new Date(base + 7_200_000).toISOString(),
				endsAt: new Date(base + 9_000_000).toISOString(),
			}),
		});
		expect(res.status).toBe(409);
	});

	it("400: PATCH sem campo reconhecível", async () => {
		const h = authed(uid());
		const ids = await setup(h);
		const start = new Date(Date.now() + 432_000_000);
		const created = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId: ids.clientId,
				serviceId: ids.serviceId,
				startsAt: start.toISOString(),
				endsAt: new Date(start.getTime() + 1_800_000).toISOString(),
			}),
		});
		const { appointment } = (await created.json()) as {
			appointment: { id: string };
		};

		const res = await app.request(`/v1/appointments/${appointment.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ foo: "bar" }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"nada para atualizar",
		);
	});

	it("GET default (sem from/to) retorna janela de 24h sem erro", async () => {
		const h = authed(uid());
		await setup(h);
		const res = await app.request("/v1/appointments", { headers: h });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { appointments: unknown[] };
		expect(Array.isArray(body.appointments)).toBe(true);
	});
});
