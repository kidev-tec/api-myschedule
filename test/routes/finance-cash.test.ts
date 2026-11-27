/**
 * Integração REAL: caixa diário (módulo de finanças, TASK-F2-03 — RF-F05).
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

const PREFIX = "FinCaixa";
const known = new Set<string>();
verifyMock.mockImplementation(async (token: string) => {
	if (!known.has(token)) throw new Error("invalid");
	return { uid: token, email: `${token}@t.com`, name: "Pro" };
});
const setup = () => setupBusiness(app, sql, known, PREFIX);
const req = (b: FinBase, method: string, path: string, body?: unknown) =>
	jsonReq(app, b.h, method, path, body);

type Movement = {
	id: string;
	kind: string;
	amount_cents: number;
	payment_method: string | null;
	voided_at: string | null;
};
type Session = {
	id: string;
	opening_cents: number;
	cash_in_cents: number;
	cash_out_cents: number;
	expected_cents: number;
	by_method: Record<string, number>;
	movements: Movement[];
	closed_at: string | null;
	counted_cents: number | null;
	difference_cents: number | null;
};

async function current(b: FinBase) {
	const r = await req(b, "GET", "/v1/finance/cash/current");
	expect(r.status).toBe(200);
	return ((await r.json()) as { session: Session | null }).session;
}
async function open(b: FinBase, opening_cents: number) {
	const r = await req(b, "POST", "/v1/finance/cash/open", { opening_cents });
	expect(r.status).toBe(201);
	return ((await r.json()) as { session: Session }).session;
}
const receive = (b: FinBase, amount_cents: number, payment_method: string) =>
	req(b, "POST", "/v1/finance/payments", { amount_cents, payment_method });
const move = (b: FinBase, direction: string, amount_cents: number) =>
	req(b, "POST", "/v1/finance/cash/movements", {
		direction,
		amount_cents,
		notes: direction === "in" ? "troco" : "depósito",
	});

afterAll(() => cleanup(sql, PREFIX));

describe("RF-F05 — caixa do dia", () => {
	it("esperado = inicial + entradas − saídas em dinheiro; fechar registra a falta", async () => {
		const b = await setup();
		expect(await current(b)).toBeNull();
		const s = await open(b, 5000);
		expect(s).toMatchObject({ opening_cents: 5000, expected_cents: 5000 });

		expect((await receive(b, 10000, "cash")).status).toBe(201);
		expect((await receive(b, 8000, "pix")).status).toBe(201);
		expect((await move(b, "in", 2000)).status).toBe(201);
		expect(
			(
				await req(b, "POST", "/v1/finance/expenses", {
					amount_cents: 3000,
					category: "materiais",
					payment_method: "cash",
				})
			).status,
		).toBe(201);
		// a pagar não mexe no caixa
		await req(b, "POST", "/v1/finance/expenses", {
			amount_cents: 9999,
			category: "aluguel",
			paid: false,
			date: new Date(Date.now() + 86400_000).toISOString(),
		});
		expect((await move(b, "out", 4000)).status).toBe(201);

		const cur = await current(b);
		expect(cur).toMatchObject({
			id: s.id,
			opening_cents: 5000,
			cash_in_cents: 12000,
			cash_out_cents: 7000,
			expected_cents: 10000,
			by_method: { cash: 10000, pix: 8000 },
			closed_at: null,
		});
		expect(cur?.movements).toHaveLength(5);

		const close = await req(b, "POST", "/v1/finance/cash/close", {
			counted_cents: 9500,
			notes: "faltou troco",
		});
		expect(close.status).toBe(200);
		const closed = ((await close.json()) as { session: Session }).session;
		expect(closed).toMatchObject({
			expected_cents: 10000,
			counted_cents: 9500,
			difference_cents: -500,
		});
		expect(closed.closed_at).not.toBeNull();
		expect(await current(b)).toBeNull();

		const h = await req(b, "GET", "/v1/finance/cash");
		const hist = ((await h.json()) as { sessions: Session[] }).sessions;
		expect(hist.map((x) => [x.id, x.difference_cents])).toEqual([[s.id, -500]]);
	});

	it("estorno sai do esperado; sem caixa o lançamento fica solto", async () => {
		const b = await setup();
		const loose = await receive(b, 700, "cash");
		const { payment: p0 } = (await loose.json()) as {
			payment: { id: string };
		};
		await open(b, 0);
		const r = await receive(b, 3000, "cash");
		const { payment } = (await r.json()) as { payment: { id: string } };
		expect((await current(b))?.expected_cents).toBe(3000);
		await req(b, "POST", `/v1/finance/transactions/${payment.id}/void`);
		const cur = await current(b);
		expect(cur?.expected_cents).toBe(0);
		expect(cur?.movements.map((m) => m.voided_at !== null)).toEqual([true]);

		const [row] = await sql<{ cash_session_id: string | null }[]>`
      SELECT cash_session_id FROM transactions WHERE id = ${p0.id}`;
		expect(row?.cash_session_id).toBeNull();
	});

	it("despesa a pagar paga em dinheiro com caixa aberto entra no caixa", async () => {
		const b = await setup();
		const r = await req(b, "POST", "/v1/finance/expenses", {
			amount_cents: 1500,
			category: "taxas",
			paid: false,
			date: new Date().toISOString(),
		});
		const { expense } = (await r.json()) as { expense: { id: string } };
		await open(b, 2000);
		await req(b, "POST", `/v1/finance/expenses/${expense.id}/pay`, {
			payment_method: "cash",
		});
		expect((await current(b))?.expected_cents).toBe(500);
	});
});

describe("RF-F05 — regras e erros", () => {
	it("2º abrir → 409; movimento/fechar sem caixa → 409", async () => {
		const b = await setup();
		expect((await move(b, "in", 100)).status).toBe(409);
		expect(await errorOf(await move(b, "in", 100))).toBe(
			"Abra o caixa primeiro",
		);
		const c0 = await req(b, "POST", "/v1/finance/cash/close", {
			counted_cents: 0,
		});
		expect(c0.status).toBe(409);
		await open(b, 0);
		const again = await req(b, "POST", "/v1/finance/cash/open", {
			opening_cents: 0,
		});
		expect(again.status).toBe(409);
		expect(await errorOf(again)).toBe("O caixa já está aberto");
	});

	it("dois abrir simultâneos: um 201 e um 409", async () => {
		const b = await setup();
		const body = { opening_cents: 100 };
		const statuses = (
			await Promise.all([
				req(b, "POST", "/v1/finance/cash/open", body),
				req(b, "POST", "/v1/finance/cash/open", body),
			])
		)
			.map((r) => r.status)
			.sort();
		expect(statuses).toEqual([201, 409]);
	});

	it("sangria acima do esperado → 422", async () => {
		const b = await setup();
		await open(b, 1000);
		const r = await move(b, "out", 1001);
		expect(r.status).toBe(422);
		expect(await errorOf(r)).toBe(
			"Não há dinheiro suficiente no caixa (esperado R$ 10,00)",
		);
		expect((await move(b, "out", 1000)).status).toBe(201);
	});

	it.each([
		["/v1/finance/cash/open", { opening_cents: -1 }, "Valor inválido"],
		["/v1/finance/cash/open", {}, "Valor inválido"],
		["/v1/finance/cash/close", { counted_cents: 1.5 }, "Valor inválido"],
		[
			"/v1/finance/cash/movements",
			{ direction: "x", amount_cents: 100 },
			"Tipo de movimento inválido",
		],
		[
			"/v1/finance/cash/movements",
			{ direction: "in", amount_cents: 0 },
			"Valor inválido",
		],
	])("%s %j → 400 %s", async (path, body, message) => {
		const b = await setup();
		const r = await req(b, "POST", path, body);
		expect(r.status).toBe(400);
		expect(await errorOf(r)).toBe(message);
	});

	it.each([
		"/v1/finance/cash/open",
		"/v1/finance/cash/close",
		"/v1/finance/cash/movements",
	])("%s com body quebrado → 400", async (path) => {
		const b = await setup();
		const r = await app.request(path, {
			method: "POST",
			headers: { "content-type": "application/json", ...b.h },
			body: "{",
		});
		expect(r.status).toBe(400);
	});

	it("histórico: período, isolamento e query inválida", async () => {
		const b = await setup();
		const other = await setup();
		await open(other, 100);
		await req(other, "POST", "/v1/finance/cash/close", { counted_cents: 100 });

		await open(b, 0);
		await req(b, "POST", "/v1/finance/cash/close", { counted_cents: 0 });
		const all = await req(b, "GET", "/v1/finance/cash");
		const s = ((await all.json()) as { sessions: Session[] }).sessions;
		expect(s).toHaveLength(1);
		expect(s[0]?.difference_cents).toBe(0);

		const past = new Date(Date.now() - 86400_000).toISOString();
		const r = await req(
			b,
			"GET",
			`/v1/finance/cash?from=${encodeURIComponent(past)}&to=${encodeURIComponent(past)}`,
		);
		expect(((await r.json()) as { sessions: Session[] }).sessions).toEqual([]);
		expect((await req(b, "GET", "/v1/finance/cash?from=x")).status).toBe(400);
	});

	it("conta vencida: abrir 402, consultar 200", async () => {
		const b = await setup();
		await sql`
      UPDATE businesses SET subscription_status = 'trial',
        trial_ends_at = now() - interval '1 day' WHERE id = ${b.businessId}`;
		expect(
			(await req(b, "POST", "/v1/finance/cash/open", { opening_cents: 0 }))
				.status,
		).toBe(402);
		expect((await req(b, "GET", "/v1/finance/cash/current")).status).toBe(200);
	});
});
