/**
 * Integração REAL: relatórios financeiros e metas
 * (módulo de finanças, TASK-F3-01 e F3-02 — RF-F07 a RF-F10).
 * Lançamentos com data fixa (passado) direto no banco; negócio no fuso
 * America/Sao_Paulo (padrão).
 */

import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({
	getApps: vi.fn(() => [{} as never]),
}));
vi.mock("../../src/services/fcm.js", () => ({
	sendToUser: vi.fn(async () => undefined),
}));

import { createApp } from "../../src/app.js";
import {
	cleanup,
	errorOf,
	type FinBase,
	jsonReq,
	setupBusiness,
} from "../helpers/finance-fixture.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";
const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

const PREFIX = "FinRel";
const known = new Set<string>();
verifyMock.mockImplementation(async (token: string) => {
	if (!known.has(token)) throw new Error("invalid");
	return { uid: token, email: `${token}@t.com`, name: "Pro" };
});
const setup = () => setupBusiness(app, sql, known, PREFIX);
const req = (b: FinBase, method: string, path: string, body?: unknown) =>
	jsonReq(app, b.h, method, path, body);

/** Lançamento direto no livro-caixa. */
async function tx(
	b: FinBase,
	at: string,
	amount: number,
	opts: {
		type?: "income" | "expense";
		kind?: string;
		method?: string | null;
		paid?: boolean;
		voided?: boolean;
	} = {},
) {
	await sql`
    INSERT INTO transactions (business_id, type, kind, amount_cents, category,
      payment_method, paid, occurred_at, voided_at)
    VALUES (${b.businessId}, ${opts.type ?? "income"}, ${opts.kind ?? "payment"},
      ${amount}, 'x', ${opts.method === undefined ? "pix" : opts.method}, ${opts.paid ?? true}, ${at},
      ${opts.voided ? new Date() : null})`;
}

let phone = 0;
async function client(b: FinBase) {
	const [c] = await sql<{ id: string }[]>`
    INSERT INTO clients (business_id, name, phone_e164)
    VALUES (${b.businessId}, 'Cli', ${`+55119${String(60000000 + phone++).slice(0, 8)}`})
    RETURNING id`;
	if (!c) throw new Error("cliente");
	return c.id;
}
async function service(b: FinBase, name: string, isKit = false) {
	const [s] = await sql<{ id: string }[]>`
    INSERT INTO services (business_id, name, duration_min, price_cents, is_kit)
    VALUES (${b.businessId}, ${name}, 30, 1000, ${isKit}) RETURNING id`;
	if (!s) throw new Error("serviço");
	return s.id;
}
/** Agendamento com status e valor; horários distintos por chamada. */
let slot = 0;
async function appt(
	b: FinBase,
	day: string,
	serviceId: string,
	clientId: string,
	price: number,
	status = "done",
) {
	const start = new Date(`${day}T12:00:00Z`);
	start.setUTCMinutes(slot++ * 40);
	await sql`
    INSERT INTO appointments (business_id, client_id, service_id, user_id,
      starts_at, ends_at, status, price_cents)
    VALUES (${b.businessId}, ${clientId}, ${serviceId}, ${b.userId}, ${start},
      ${new Date(start.getTime() + 1800_000)}, ${status}, ${price})`;
}

type Summary = {
	from: string;
	to: string;
	revenue_cents: number;
	expenses_cents: number;
	result_cents: number;
	by_method: Record<string, number>;
	series: { date: string; revenue_cents: number; expenses_cents: number }[];
	done_count: number;
	sold_cents: number;
	avg_ticket_cents: number;
	avg_per_client_cents: number;
	open_cents: number;
};
async function summary(b: FinBase, from: string, to: string) {
	const r = await req(
		b,
		"GET",
		`/v1/finance/reports/summary?from=${from}&to=${to}`,
	);
	expect(r.status).toBe(200);
	return (await r.json()) as Summary;
}

afterAll(() => cleanup(sql, PREFIX));

describe("RF-F07 — faturamento do período (regime de caixa, fuso do negócio)", () => {
	it("soma recebimentos e despesas pagas; ignora estorno, suprimento, sangria e a pagar", async () => {
		const b = await setup();
		await tx(b, "2026-10-05T15:00:00Z", 3000, { kind: "deposit" });
		await tx(b, "2026-10-05T18:00:00Z", 7000, { method: "cash" });
		await tx(b, "2026-10-06T15:00:00Z", 5000, { method: "credit" });
		await tx(b, "2026-10-06T16:00:00Z", 9999, { voided: true });
		await tx(b, "2026-10-06T16:00:00Z", 2000, {
			kind: "cash_in",
			method: "cash",
		});
		await tx(b, "2026-10-06T17:00:00Z", 1500, {
			type: "expense",
			kind: "cash_out",
			method: "cash",
		});
		await tx(b, "2026-10-06T17:00:00Z", 4000, {
			type: "expense",
			kind: "expense",
		});
		await tx(b, "2026-10-07T12:00:00Z", 800, {
			type: "expense",
			kind: "expense",
			paid: false,
		});

		const s = await summary(b, "2026-10-05", "2026-10-07");
		expect(s).toMatchObject({
			from: "2026-10-05",
			to: "2026-10-07",
			revenue_cents: 15000,
			expenses_cents: 4000,
			result_cents: 11000,
			by_method: { pix: 3000, cash: 7000, credit: 5000 },
		});
		expect(s.series).toEqual([
			{ date: "2026-10-05", revenue_cents: 10000, expenses_cents: 0 },
			{ date: "2026-10-06", revenue_cents: 5000, expenses_cents: 4000 },
			{ date: "2026-10-07", revenue_cents: 0, expenses_cents: 0 },
		]);
	});

	it('recebimento antigo sem forma de pagamento entra em "other"', async () => {
		const b = await setup();
		await tx(b, "2026-10-08T15:00:00Z", 1200, { method: null });
		const s = await summary(b, "2026-10-08", "2026-10-08");
		expect(s.by_method).toEqual({ other: 1200 });
	});

	it("23:30 de Brasília (02:30 UTC do dia seguinte) conta no dia local", async () => {
		const b = await setup();
		await tx(b, "2026-10-11T02:30:00Z", 4200);
		const d10 = await summary(b, "2026-10-10", "2026-10-10");
		expect(d10.revenue_cents).toBe(4200);
		const d11 = await summary(b, "2026-10-11", "2026-10-11");
		expect(d11.revenue_cents).toBe(0);
	});

	it("isolamento por negócio e em aberto atual", async () => {
		const b = await setup();
		const other = await setup();
		await tx(other, "2026-10-05T15:00:00Z", 5000);
		// em aberto: concluído sem pagamento
		await appt(b, "2026-10-05", b.serviceId, b.clientId, 6000);
		const s = await summary(b, "2026-10-05", "2026-10-05");
		expect(s.revenue_cents).toBe(0);
		expect(s.open_cents).toBe(6000);
	});

	it.each([
		["from=x&to=2026-10-01", "Data inválida (use AAAA-MM-DD)"],
		["from=2026-02-30&to=2026-03-01", "Data inválida (use AAAA-MM-DD)"],
		["to=2026-10-01", "Data inválida (use AAAA-MM-DD)"],
		["from=2026-10-02&to=2026-10-01", "A data inicial deve ser antes da final"],
		["from=2025-01-01&to=2026-10-01", "Período máximo: 366 dias"],
	])("%s → 400", async (q, message) => {
		const b = await setup();
		for (const path of ["summary", "services"]) {
			const r = await req(b, "GET", `/v1/finance/reports/${path}?${q}`);
			expect(r.status).toBe(400);
			expect(await errorOf(r)).toBe(message);
		}
	});
});

describe("RF-F08/RF-F09 — por serviço e ticket médio (atendimentos concluídos)", () => {
	it("agrupa por serviço (kit como kit) e calcula os tickets", async () => {
		const b = await setup();
		const corte = await service(b, "Corte");
		const combo = await service(b, "Corte + Barba", true);
		const ana = await client(b);
		const bia = await client(b);
		await appt(b, "2026-10-20", corte, ana, 5000);
		await appt(b, "2026-10-20", corte, bia, 4000);
		await appt(b, "2026-10-21", combo, ana, 6000);
		await appt(b, "2026-10-21", corte, ana, 9999, "canceled");
		await appt(b, "2026-10-21", corte, ana, 9999, "confirmed");
		await appt(b, "2026-11-01", corte, ana, 9999);

		const r = await req(
			b,
			"GET",
			"/v1/finance/reports/services?from=2026-10-20&to=2026-10-21",
		);
		expect(r.status).toBe(200);
		const { items } = (await r.json()) as {
			items: {
				service_name: string;
				is_kit: boolean;
				count: number;
				total_cents: number;
			}[];
		};
		expect(
			items.map((i) => [i.service_name, i.is_kit, i.count, i.total_cents]),
		).toEqual([
			["Corte", false, 2, 9000],
			["Corte + Barba", true, 1, 6000],
		]);

		const s = await summary(b, "2026-10-20", "2026-10-21");
		expect(s).toMatchObject({
			done_count: 3,
			sold_cents: 15000,
			avg_ticket_cents: 5000,
			avg_per_client_cents: 7500,
		});
	});

	it("sem atendimentos: tickets 0", async () => {
		const b = await setup();
		const s = await summary(b, "2026-09-01", "2026-09-30");
		expect(s).toMatchObject({
			done_count: 0,
			sold_cents: 0,
			avg_ticket_cents: 0,
			avg_per_client_cents: 0,
		});
		expect(s.series).toHaveLength(30);
	});
});

describe("RF-F10 — metas", () => {
	type Goal = {
		month: string;
		target_cents: number | null;
		achieved_cents: number;
		percent: number | null;
		remaining_cents: number;
		days_left: number;
		needed_per_day_cents: number;
	};
	const goal = async (b: FinBase, month: string) => {
		const r = await req(b, "GET", `/v1/finance/goals/${month}`);
		expect(r.status).toBe(200);
		return (await r.json()) as Goal;
	};

	it("definir, atualizar e remover; mês passado tem 0 dias restantes", async () => {
		const b = await setup();
		await tx(b, "2026-10-10T15:00:00Z", 25000);
		expect(await goal(b, "2026-10")).toMatchObject({
			target_cents: null,
			percent: null,
			achieved_cents: 25000,
		});

		const put = await req(b, "PUT", "/v1/finance/goals/2026-10", {
			target_cents: 100000,
		});
		expect(put.status).toBe(200);
		expect(await goal(b, "2026-10")).toEqual({
			month: "2026-10",
			target_cents: 100000,
			achieved_cents: 25000,
			percent: 25,
			remaining_cents: 75000,
			days_left: 0,
			needed_per_day_cents: 0,
		});

		await req(b, "PUT", "/v1/finance/goals/2026-10", { target_cents: 20000 });
		expect(await goal(b, "2026-10")).toMatchObject({
			percent: 125,
			remaining_cents: 0,
		});

		const del = await req(b, "DELETE", "/v1/finance/goals/2026-10");
		expect(del.status).toBe(200);
		expect((await goal(b, "2026-10")).target_cents).toBeNull();
	});

	it("mês atual: dias restantes contam hoje e valor por dia", async () => {
		const b = await setup();
		const [today] = await sql<{ d: string; last: number; day: number }[]>`
      SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS d,
        extract(day FROM (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')
          + interval '1 month - 1 day'))::int AS last,
        extract(day FROM now() AT TIME ZONE 'America/Sao_Paulo')::int AS day`;
		if (!today) throw new Error("hoje");
		await req(b, "PUT", `/v1/finance/goals/${today.d}`, {
			target_cents: 90000,
		});
		const g = await goal(b, today.d);
		const days = today.last - today.day + 1;
		expect(g.days_left).toBe(days);
		expect(g.needed_per_day_cents).toBe(Math.ceil(90000 / days));
	});

	it("mês futuro: todos os dias do mês", async () => {
		const b = await setup();
		await req(b, "PUT", "/v1/finance/goals/2099-02", { target_cents: 2800 });
		const g = await goal(b, "2099-02");
		expect(g.days_left).toBe(28);
		expect(g.needed_per_day_cents).toBe(100);
	});

	it("validação, isolamento e paywall", async () => {
		const b = await setup();
		const other = await setup();
		for (const m of ["2026-13", "2026-1", "abc"]) {
			expect((await req(b, "GET", `/v1/finance/goals/${m}`)).status).toBe(400);
			expect(
				(await req(b, "PUT", `/v1/finance/goals/${m}`, { target_cents: 1 }))
					.status,
			).toBe(400);
			expect((await req(b, "DELETE", `/v1/finance/goals/${m}`)).status).toBe(
				400,
			);
		}
		const zero = await req(b, "PUT", "/v1/finance/goals/2026-10", {
			target_cents: 0,
		});
		expect(zero.status).toBe(400);
		expect(await errorOf(zero)).toBe("Valor inválido");
		const broken = await app.request("/v1/finance/goals/2026-10", {
			method: "PUT",
			headers: { "content-type": "application/json", ...b.h },
			body: "{",
		});
		expect(broken.status).toBe(400);

		await req(other, "PUT", "/v1/finance/goals/2026-10", {
			target_cents: 5000,
		});
		expect((await goal(b, "2026-10")).target_cents).toBeNull();

		await sql`
      UPDATE businesses SET subscription_status = 'trial',
        trial_ends_at = now() - interval '1 day' WHERE id = ${b.businessId}`;
		expect(
			(await req(b, "PUT", "/v1/finance/goals/2026-10", { target_cents: 1 }))
				.status,
		).toBe(402);
		expect((await req(b, "GET", "/v1/finance/goals/2026-10")).status).toBe(200);
		expect(
			(
				await req(
					b,
					"GET",
					"/v1/finance/reports/summary?from=2026-10-01&to=2026-10-01",
				)
			).status,
		).toBe(200);
	});
});
