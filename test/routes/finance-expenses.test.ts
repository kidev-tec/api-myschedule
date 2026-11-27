/**
 * Integração REAL: despesas (módulo de finanças, TASK-F2-02 — RF-F06).
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

const PREFIX = "FinDesp";
const known = new Set<string>();
verifyMock.mockImplementation(async (token: string) => {
	if (!known.has(token)) throw new Error("invalid");
	return { uid: token, email: `${token}@t.com`, name: "Pro" };
});
const setup = () => setupBusiness(app, sql, known, PREFIX);
const req = (b: FinBase, method: string, path: string, body?: unknown) =>
	jsonReq(app, b.h, method, path, body);

const DAY = 24 * 3600_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

type Expense = {
	id: string;
	amount_cents: number;
	category: string;
	payment_method: string | null;
	paid: boolean;
	due_at: string | null;
	occurred_at: string;
	notes: string | null;
	voided_at: string | null;
	overdue: boolean;
};
type List = {
	items: Expense[];
	paid_cents: number;
	pending_cents: number;
	overdue_cents: number;
};

async function create(b: FinBase, body: Record<string, unknown>) {
	const r = await req(b, "POST", "/v1/finance/expenses", body);
	expect(r.status).toBe(201);
	return ((await r.json()) as { expense: Expense }).expense;
}
async function list(b: FinBase, query = "") {
	const r = await req(b, "GET", `/v1/finance/expenses${query}`);
	expect(r.status).toBe(200);
	return (await r.json()) as List;
}

afterAll(() => cleanup(sql, PREFIX));

describe("RF-F06 — lançar despesas", () => {
	it("paga (padrão) e a pagar; totais separados; vencida conta em overdue", async () => {
		const b = await setup();
		const paid = await create(b, {
			amount_cents: 15000,
			category: "aluguel",
			payment_method: "pix",
		});
		expect(paid).toMatchObject({
			paid: true,
			due_at: null,
			payment_method: "pix",
			overdue: false,
		});
		const future = await create(b, {
			amount_cents: 4000,
			category: "energia_agua",
			paid: false,
			date: iso(10 * DAY),
		});
		expect(future).toMatchObject({
			paid: false,
			payment_method: null,
			overdue: false,
		});
		expect(future.due_at).not.toBeNull();
		const late = await create(b, {
			amount_cents: 2500,
			category: "outros",
			notes: "  Conserto da cadeira  ",
			paid: false,
			date: iso(-DAY),
		});
		expect(late.overdue).toBe(true);
		expect(late.notes).toBe("Conserto da cadeira");

		const l = await list(b);
		expect(l.items.map((i) => i.id).sort()).toEqual(
			[paid.id, future.id, late.id].sort(),
		);
		expect(l.paid_cents).toBe(15000);
		expect(l.pending_cents).toBe(6500);
		expect(l.overdue_cents).toBe(2500);
	});

	it.each([
		[
			{ amount_cents: 0, category: "taxas", payment_method: "pix" },
			"Valor inválido",
		],
		[
			{ amount_cents: 100, category: "mercado", payment_method: "pix" },
			"Categoria inválida",
		],
		[{ amount_cents: 100, category: "taxas" }, "Informe a forma de pagamento"],
		[
			{ amount_cents: 100, category: "taxas", paid: false },
			"Informe o vencimento",
		],
		[
			{
				amount_cents: 100,
				category: "outros",
				payment_method: "cash",
				notes: " ",
			},
			"Descreva a despesa",
		],
		[
			{
				amount_cents: 100,
				category: "taxas",
				payment_method: "cash",
				date: "ontem",
			},
			"Data inválida",
		],
	])("%j → 400 %s", async (body, message) => {
		const b = await setup();
		const r = await req(b, "POST", "/v1/finance/expenses", body);
		expect(r.status).toBe(400);
		expect(await errorOf(r)).toBe(message);
	});

	it("body quebrado → 400", async () => {
		const b = await setup();
		const r = await app.request("/v1/finance/expenses", {
			method: "POST",
			headers: { "content-type": "application/json", ...b.h },
			body: "{",
		});
		expect(r.status).toBe(400);
	});
});

describe("RF-F06 — pagar despesa a pagar", () => {
	it("vira paga com a data do pagamento; de novo → 409", async () => {
		const b = await setup();
		const e = await create(b, {
			amount_cents: 3000,
			category: "materiais",
			paid: false,
			date: iso(5 * DAY),
		});
		const r = await req(b, "POST", `/v1/finance/expenses/${e.id}/pay`, {
			payment_method: "debit",
		});
		expect(r.status).toBe(200);
		const { expense } = (await r.json()) as { expense: Expense };
		expect(expense).toMatchObject({ paid: true, payment_method: "debit" });
		expect(
			Math.abs(new Date(expense.occurred_at).getTime() - Date.now()),
		).toBeLessThan(60_000);

		const again = await req(b, "POST", `/v1/finance/expenses/${e.id}/pay`, {
			payment_method: "debit",
		});
		expect(again.status).toBe(409);
		expect(await errorOf(again)).toBe("Esta despesa já está paga");

		// pagamento com data informada (ex.: pagou ontem e lançou hoje)
		const e2 = await create(b, {
			amount_cents: 1000,
			category: "taxas",
			paid: false,
			date: iso(DAY),
		});
		const paidAt = iso(-DAY);
		const r2 = await req(b, "POST", `/v1/finance/expenses/${e2.id}/pay`, {
			payment_method: "pix",
			date: paidAt,
		});
		const p2 = ((await r2.json()) as { expense: Expense }).expense;
		expect(new Date(p2.occurred_at).toISOString()).toBe(paidAt);
	});

	it("estornada → 409; outro negócio → 404; sem forma → 400; id inválido → 400", async () => {
		const b = await setup();
		const other = await setup();
		const e = await create(b, {
			amount_cents: 3000,
			category: "marketing",
			paid: false,
			date: iso(DAY),
		});
		await req(b, "POST", `/v1/finance/transactions/${e.id}/void`);
		const r1 = await req(b, "POST", `/v1/finance/expenses/${e.id}/pay`, {
			payment_method: "pix",
		});
		expect(r1.status).toBe(409);
		expect(await errorOf(r1)).toBe("Esta despesa foi estornada");

		const r2 = await req(other, "POST", `/v1/finance/expenses/${e.id}/pay`, {
			payment_method: "pix",
		});
		expect(r2.status).toBe(404);
		expect(await errorOf(r2)).toBe("Despesa não encontrada");

		const r3 = await req(b, "POST", `/v1/finance/expenses/${e.id}/pay`, {});
		expect(r3.status).toBe(400);
		expect(await errorOf(r3)).toBe("Forma de pagamento inválida");

		const r4 = await req(b, "POST", "/v1/finance/expenses/abc/pay", {
			payment_method: "pix",
		});
		expect(r4.status).toBe(400);

		const r5 = await app.request(`/v1/finance/expenses/${e.id}/pay`, {
			method: "POST",
			headers: { "content-type": "application/json", ...b.h },
			body: "{",
		});
		expect(r5.status).toBe(400);
	});

	it("recebimento não é despesa (404 ao pagar)", async () => {
		const b = await setup();
		const r = await req(b, "POST", "/v1/finance/payments", {
			amount_cents: 500,
			payment_method: "cash",
		});
		const { payment } = (await r.json()) as { payment: { id: string } };
		const p = await req(b, "POST", `/v1/finance/expenses/${payment.id}/pay`, {
			payment_method: "pix",
		});
		expect(p.status).toBe(404);
	});
});

describe("RF-F06 — listar e filtrar", () => {
	it("filtra por período, categoria e status; estornada não soma", async () => {
		const b = await setup();
		const now = await create(b, {
			amount_cents: 1000,
			category: "taxas",
			payment_method: "pix",
		});
		const old = await create(b, {
			amount_cents: 2000,
			category: "aluguel",
			payment_method: "pix",
			date: iso(-40 * DAY),
		});
		const due = await create(b, {
			amount_cents: 3000,
			category: "aluguel",
			paid: false,
			date: iso(3 * DAY),
		});
		const voided = await create(b, {
			amount_cents: 9000,
			category: "taxas",
			payment_method: "cash",
		});
		await req(b, "POST", `/v1/finance/transactions/${voided.id}/void`);

		const period = `?from=${encodeURIComponent(iso(-DAY))}&to=${encodeURIComponent(iso(5 * DAY))}`;
		const l1 = await list(b, period);
		expect(l1.items.map((i) => i.id).sort()).toEqual(
			[now.id, due.id, voided.id].sort(),
		);
		expect(l1.paid_cents).toBe(1000);
		expect(l1.pending_cents).toBe(3000);
		expect(l1.items.find((i) => i.id === voided.id)?.voided_at).not.toBeNull();

		const l2 = await list(b, "?category=aluguel");
		expect(l2.items.map((i) => i.id).sort()).toEqual([old.id, due.id].sort());

		const l3 = await list(b, "?status=pending");
		expect(l3.items.map((i) => i.id)).toEqual([due.id]);

		const l4 = await list(b, "?status=paid&category=taxas");
		expect(l4.items.map((i) => i.id).sort()).toEqual(
			[now.id, voided.id].sort(),
		);

		expect((await req(b, "GET", "/v1/finance/expenses?status=x")).status).toBe(
			400,
		);
		expect(
			(await req(b, "GET", "/v1/finance/expenses?category=x")).status,
		).toBe(400);
		expect((await req(b, "GET", "/v1/finance/expenses?to=x")).status).toBe(400);
	});

	it("recebimentos não aparecem; outro negócio não vê", async () => {
		const b = await setup();
		const other = await setup();
		await req(b, "POST", "/v1/finance/payments", {
			amount_cents: 500,
			payment_method: "cash",
		});
		await create(other, {
			amount_cents: 700,
			category: "taxas",
			payment_method: "pix",
		});
		const l = await list(b);
		expect(l.items).toEqual([]);
		expect(l.paid_cents).toBe(0);
	});

	it("conta vencida: lançar 402, listar 200", async () => {
		const b = await setup();
		await sql`
      UPDATE businesses SET subscription_status = 'trial',
        trial_ends_at = now() - interval '1 day' WHERE id = ${b.businessId}`;
		const r = await req(b, "POST", "/v1/finance/expenses", {
			amount_cents: 100,
			category: "taxas",
			payment_method: "pix",
		});
		expect(r.status).toBe(402);
		expect((await req(b, "GET", "/v1/finance/expenses")).status).toBe(200);
	});
});
