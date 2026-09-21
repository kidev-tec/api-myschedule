/**
 * Integração REAL: horário passado não muda de estado (decisão de produto
 * 21/09). PATCH /appointments/:id com status (canceled/done/noshow/confirmed)
 * sobre startsAt já passado → 400 com mensagem humana.
 * Remarcação (startsAt/endsAt na mesma request) continua legítima.
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
		VALUES (${biz.id}, 'Cli', ${"+5511" + String(90000000 + seq).slice(0, 8)})
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
			endsAt: iso(new Date(startsAt).getTime() + 1800_000),
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

describe("horário passado não muda de estado (produto 21/09)", () => {
	it.each(["canceled", "done", "noshow", "confirmed"] as const)(
		"PATCH status=%s sobre horário passado → 400",
		async (status) => {
			const h = authed(uid());
			const base = await setupBase(h);
			// cria direto no passado (a API não deixaria criar no passado)
			const id = await createAppt(h, base, iso(-3600_000));
			expect(id).toBeTruthy();

			const res = await app.request(`/v1/appointments/${id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json", ...h },
				body: JSON.stringify({ status }),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toContain("já passou");
		},
	);

	it("PATCH status sobre horário futuro → 200 (cancelamento com antecedência livre)", async () => {
		const h = authed(uid());
		const base = await setupBase(h);
		const id = await createAppt(h, base, iso(3600_000));

		const res = await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "canceled", canceledReason: "cliente" }),
		});
		expect(res.status).toBe(200);
	});

	it("remarcar horário passado (startsAt na mesma request) continua funcionando", async () => {
		const h = authed(uid());
		const base = await setupBase(h);
		const id = await createAppt(h, base, iso(-3600_000));

		const res = await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ startsAt: iso(7200_000) }),
		});
		expect(res.status).toBe(200);
	});

	it("remarcar + confirmar na mesma request de horário passado → 200", async () => {
		const h = authed(uid());
		const base = await setupBase(h);
		const id = await createAppt(h, base, iso(-3600_000));

		const res = await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "confirmed", startsAt: iso(7200_000) }),
		});
		expect(res.status).toBe(200);
	});

	it("status + só endsAt (sem startsAt) cobre fallback newStart → 200", async () => {
		const h = authed(uid());
		const base = await setupBase(h);
		const id = await createAppt(h, base, iso(-3600_000));

		const res = await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				status: "confirmed",
				endsAt: iso(1800_000),
			}),
		});
		expect(res.status).toBe(200);
	});
});
