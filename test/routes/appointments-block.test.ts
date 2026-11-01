/**
 * RF-A01..A03 — Bloqueio de horário (source='block'): integração REAL.
 * Mesmo padrão de integration.test.ts: Firebase mockado, Postgres real.
 * Bloqueio OCUPA slot (clientes não veem no /busy) e é removível.
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

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = 0;
const uid = () => `test-uid-block-${Date.now()}-${seq++}`;

function authed(uidValue: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== uidValue) throw new Error("invalid");
		return { uid: uidValue, email: `${uidValue}@t.com`, name: "Pro Block" };
	});
	return { Authorization: `Bearer ${uidValue}` };
}

async function one<T>(q: Promise<{ id: string }[]>): Promise<T> {
	const rows = await q;
	return rows[0] as T;
}

/** Amanhã às hh:mm local — evita colisão com dados de outros testes. */
const dayAt = (hour: number) => {
	const d = new Date();
	d.setDate(d.getDate() + 1);
	d.setHours(hour, 0, 0, 0);
	return d;
};

describe("RF-A — bloqueio de horário (source='block')", () => {
	let h: Record<string, string>;
	let businessId: string;
	let clientId: string;
	let serviceId: string;

	beforeAll(async () => {
		await sql`SELECT 1`;
		h = authed(uid());
		const sync = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro Block Suite" }),
		});
		expect(sync.status).toBe(201);
		const body = (await sync.json()) as { business: { id: string } };
		businessId = body.business.id;
		console.error("[dbg beforeAll] businessId =", businessId);

		clientId = (
			await one<{ id: string }>(sql`
			INSERT INTO clients (business_id, name, phone_e164)
			VALUES (${businessId}, 'Block Fake', '+5511999990001') RETURNING id`)
		).id;
		serviceId = (
			await one<{ id: string }>(sql`
			INSERT INTO services (business_id, name, duration_min, price_cents)
			VALUES (${businessId}, 'Bloqueio', 60, 0) RETURNING id`)
		).id;
	});

	afterAll(async () => {
		await sql`DELETE FROM appointments WHERE business_id = ${businessId}`;
		await sql`DELETE FROM clients WHERE business_id = ${businessId}`;
		await sql`DELETE FROM services WHERE business_id = ${businessId}`;
		await sql`DELETE FROM users WHERE business_id = ${businessId} AND email LIKE 'test-uid-block-%'`;
		await sql`DELETE FROM businesses WHERE id = ${businessId}`;
		await sql.end();
	});

	const post = (body: Record<string, unknown>) =>
		app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify(body),
		});

	it("RF-A01: POST com source='block' cria bloqueio confirmado que OCUPA o slot", async () => {
		const res = await post({
			clientId,
			serviceId,
			startsAt: dayAt(10).toISOString(),
			endsAt: dayAt(11).toISOString(),
			source: "block",
		});
		if (res.status !== 201)
			console.error("[dbg RF-A01]", res.status, await res.text());
		expect(res.status).toBe(201);
		const { appointment } = (await res.json()) as {
			appointment: { source: string; status: string };
		};
		expect(appointment.source).toBe("block");
		expect(appointment.status).toBe("confirmed");

		// slot ocupado: agendamento normal no mesmo intervalo → 409
		const conflict = await post({
			clientId,
			serviceId,
			startsAt: dayAt(10).toISOString(),
			endsAt: dayAt(11).toISOString(),
		});
		expect(conflict.status).toBe(409);
	});

	it("RF-A02: source inválida → 400", async () => {
		const res = await post({
			clientId,
			serviceId,
			startsAt: dayAt(12).toISOString(),
			endsAt: dayAt(13).toISOString(),
			source: "xxx",
		});
		expect(res.status).toBe(400);
	});

	it("RF-A02b: motivo do bloqueio (canceledReason) aceito no POST e visível no GET", async () => {
		const res = await post({
			clientId,
			serviceId,
			startsAt: dayAt(14).toISOString(),
			endsAt: dayAt(15).toISOString(),
			source: "block",
			canceledReason: "dentista",
		});
		expect(res.status).toBe(201);

		const list = await app.request(
			`/v1/appointments?from=${dayAt(0).toISOString()}&to=${dayAt(23).toISOString()}`,
			{ headers: h },
		);
		expect(list.status).toBe(200);
		const { appointments } = (await list.json()) as {
			appointments: Array<{ source: string; canceledReason: string | null }>;
		};
		const block = appointments.find(
			(a) => a.source === "block" && a.canceledReason === "dentista",
		);
		expect(block).toBeTruthy();
	});

	it("RF-A03: cancelar bloqueio libera o slot (reagendamento normal → 201)", async () => {
		const res = await post({
			clientId,
			serviceId,
			startsAt: dayAt(16).toISOString(),
			endsAt: dayAt(17).toISOString(),
			source: "block",
		});
		expect(res.status).toBe(201);
		const { appointment } = (await res.json()) as {
			appointment: { id: string };
		};

		const del = await app.request(`/v1/appointments/${appointment.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "canceled" }),
		});
		expect(del.status).toBe(200);

		const rebook = await post({
			clientId,
			serviceId,
			startsAt: dayAt(16).toISOString(),
			endsAt: dayAt(17).toISOString(),
		});
		expect(rebook.status).toBe(201);
	});

	it("bloqueio sem clientId/serviceId: API usa par técnico oculto e reaproveita", async () => {
		const mk = (hora: number) =>
			post({
				startsAt: dayAt(hora).toISOString(),
				endsAt: dayAt(hora + 1).toISOString(),
				source: "block",
				canceledReason: "almoço",
			});
		expect((await mk(18)).status).toBe(201);
		expect((await mk(20)).status).toBe(201); // 2º reaproveita o par

		const pair = await sql<{ n: number }[]>`
			SELECT
			  (SELECT count(*)::int FROM services WHERE business_id = ${businessId}
			     AND name = 'Bloqueio' AND archived_at IS NOT NULL)
			+ (SELECT count(*)::int FROM clients WHERE business_id = ${businessId}
			     AND name = '— bloqueio —' AND deleted_at IS NOT NULL) AS n`;
		expect(pair[0]?.n).toBe(2); // 1 serviço + 1 cliente, nunca duplica

		// oculto: fora das listas e do link público
		const get = async (path: string) =>
			(await app.request(path, { headers: { ...h } })).json();
		const svcs = (await get("/v1/services")) as { name: string; id: string }[];
		expect(svcs.some((s) => s.id !== serviceId && s.name === "Bloqueio")).toBe(
			false,
		);
		const clis = (await get("/v1/clients")) as { name: string }[];
		expect(clis.some((c) => c.name === "— bloqueio —")).toBe(false);
		const [biz] = await sql<{ slug: string }[]>`
			SELECT slug FROM businesses WHERE id = ${businessId}`;
		const info = (await (await app.request(`/p/${biz?.slug}/info`)).json()) as {
			services: { id: string; name: string }[];
		};
		expect(
			info.services.some((s) => s.id !== serviceId && s.name === "Bloqueio"),
		).toBe(false);

		// e ocupa o horário na agenda com o motivo
		const list = (await get(
			`/v1/appointments?from=${dayAt(0).toISOString()}&to=${dayAt(23).toISOString()}`,
		)) as {
			appointments: { source: string; canceledReason: string | null }[];
		};
		expect(
			list.appointments.filter(
				(a) => a.source === "block" && a.canceledReason === "almoço",
			),
		).toHaveLength(2);
	});
});
