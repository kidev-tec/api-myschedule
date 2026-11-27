/**
 * Integração REAL: fluxo de caixa projetado e comprovante
 * (módulo de finanças, TASK-F4-01 e F4-02 — RF-F11, RF-F12).
 * Negócio no fuso America/Sao_Paulo (padrão).
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
import { dayKey } from "../../src/domain/schedule-day.js";
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

const PREFIX = "FinFluxo";
const known = new Set<string>();
verifyMock.mockImplementation(async (token: string) => {
	if (!known.has(token)) throw new Error("invalid");
	return { uid: token, email: `${token}@t.com`, name: "Pro" };
});
const setup = () => setupBusiness(app, sql, known, PREFIX);
const req = (b: FinBase, method: string, path: string, body?: unknown) =>
	jsonReq(app, b.h, method, path, body);

const TZ = "America/Sao_Paulo";
const DAY = 86_400_000;
/** Dia local (Brasília) daqui a [n] dias, 12:00 local (15:00 UTC). */
function localNoon(n: number): Date {
	const key = dayKey(new Date(Date.now() + n * DAY), TZ);
	return new Date(`${key}T15:00:00Z`);
}
const key = (n: number) => dayKey(new Date(Date.now() + n * DAY), TZ);

let slot = 0;
async function appt(
	b: FinBase,
	at: Date,
	price: number,
	opts: { status?: string; source?: string; exact?: boolean } = {},
) {
	// até +5h30 a partir do meio-dia local: nunca vira o dia
	const start = opts.exact
		? at
		: new Date(at.getTime() + (slot++ % 12) * 30 * 60_000);
	const [a] = await sql<{ id: string }[]>`
    INSERT INTO appointments (business_id, client_id, service_id, user_id,
      starts_at, ends_at, status, source, price_cents)
    VALUES (${b.businessId}, ${b.clientId}, ${b.serviceId}, ${b.userId}, ${start},
      ${new Date(start.getTime() + 1800_000)}, ${opts.status ?? "confirmed"},
      ${opts.source ?? "app"}, ${price})
    RETURNING id`;
	if (!a) throw new Error("agendamento");
	return a.id;
}
async function income(
	b: FinBase,
	appointmentId: string | null,
	amount: number,
) {
	const [t] = await sql<{ id: string }[]>`
    INSERT INTO transactions (business_id, type, kind, amount_cents, category,
      payment_method, appointment_id, client_id)
    VALUES (${b.businessId}, 'income', 'payment', ${amount}, 'atendimento',
      'pix', ${appointmentId}, ${appointmentId ? b.clientId : null})
    RETURNING id`;
	if (!t) throw new Error("recebimento");
	return t.id;
}
async function bill(
	b: FinBase,
	due: Date,
	amount: number,
	opts: { paid?: boolean; voided?: boolean; notes?: string } = {},
) {
	await sql`
    INSERT INTO transactions (business_id, type, kind, amount_cents, category,
      paid, due_at, occurred_at, notes, voided_at)
    VALUES (${b.businessId}, 'expense', 'expense', ${amount}, 'aluguel',
      ${opts.paid ?? false}, ${due}, ${due}, ${opts.notes ?? null},
      ${opts.voided ? new Date() : null})`;
}

type Flow = {
	from: string;
	to: string;
	inflow_cents: number;
	outflow_cents: number;
	net_cents: number;
	overdue_in_cents: number;
	overdue_out_cents: number;
	days: {
		date: string;
		inflow_cents: number;
		outflow_cents: number;
		balance_cents: number;
		items: { kind: string; id: string; label: string; amount_cents: number }[];
	}[];
};
async function flow(b: FinBase, q = "") {
	const r = await req(b, "GET", `/v1/finance/cashflow${q}`);
	expect(r.status).toBe(200);
	return (await r.json()) as Flow;
}

afterAll(() => cleanup(sql, PREFIX));

describe("RF-F11 — fluxo de caixa projetado", () => {
	it("entradas pelo saldo dos agendamentos, saídas pelas despesas a pagar, saldo acumulado", async () => {
		const b = await setup();
		const a1 = await appt(b, localNoon(2), 10000);
		await income(b, a1, 3000); // sinal: entra só o restante
		await appt(b, localNoon(2), 5000, { status: "canceled" });
		await appt(b, localNoon(3), 0, { source: "block" });
		const paidOff = await appt(b, localNoon(3), 4000);
		await income(b, paidOff, 4000);
		await bill(b, localNoon(5), 9000, { notes: "Aluguel" });
		await bill(b, localNoon(5), 500, { paid: true });
		await bill(b, localNoon(6), 700, { voided: true });

		const f = await flow(b, "?days=7");
		expect(f.from).toBe(key(0));
		expect(f.to).toBe(key(6));
		expect(f.days).toHaveLength(7);
		expect(f).toMatchObject({
			inflow_cents: 7000,
			outflow_cents: 9000,
			net_cents: -2000,
			overdue_in_cents: 0,
			overdue_out_cents: 0,
		});
		const d2 = f.days[2];
		expect(d2).toMatchObject({
			date: key(2),
			inflow_cents: 7000,
			balance_cents: 7000,
		});
		expect(d2?.items).toEqual([
			{
				kind: "appointment",
				id: a1,
				label: "Ana • Escova",
				amount_cents: 7000,
			},
		]);
		expect(f.days[4]?.balance_cents).toBe(7000);
		expect(f.days[5]).toMatchObject({
			outflow_cents: 9000,
			balance_cents: -2000,
		});
		expect(f.days[5]?.items[0]).toMatchObject({
			kind: "expense",
			label: "Aluguel",
		});
		expect(f.days[0]?.items).toEqual([]);
	});

	it("atrasados ficam fora da série; despesa sem descrição usa a categoria", async () => {
		const b = await setup();
		const late = await appt(b, localNoon(-1), 6000, { status: "done" });
		await income(b, late, 1000);
		await bill(b, localNoon(-2), 800);
		await bill(b, localNoon(1), 300);
		const f = await flow(b);
		expect(f.days).toHaveLength(30);
		expect(f.overdue_in_cents).toBe(5000);
		expect(f.overdue_out_cents).toBe(800);
		expect(f.inflow_cents).toBe(0);
		expect(f.days[1]?.items[0]?.label).toBe("Aluguel");
	});

	it("23:30 de Brasília cai no dia local", async () => {
		const b = await setup();
		// dia local +3 às 23:30 = 02:30 UTC do dia +4
		const at = new Date(`${key(3)}T23:30:00-03:00`);
		await appt(b, at, 1200, { exact: true });
		const f = await flow(b, "?days=5");
		expect(f.days[3]?.inflow_cents).toBe(1200);
		expect(f.days[4]?.inflow_cents).toBe(0);
	});

	it.each(["0", "91", "x", "1.5"])("days=%s → 400", async (d) => {
		const b = await setup();
		const r = await req(b, "GET", `/v1/finance/cashflow?days=${d}`);
		expect(r.status).toBe(400);
		expect(await errorOf(r)).toBe("Período inválido (1 a 90 dias)");
	});

	it("isolamento por negócio", async () => {
		const b = await setup();
		const other = await setup();
		await appt(other, localNoon(1), 9999);
		expect((await flow(b, "?days=3")).inflow_cents).toBe(0);
	});
});

describe("RF-F12 — comprovante", () => {
	type Receipt = {
		number: number;
		payment: {
			id: string;
			amount_cents: number;
			payment_method: string;
			installments: number;
			kind: string;
			occurred_at: string;
			notes: string | null;
		};
		business: {
			name: string;
			address: string | null;
			logo_url: string | null;
		};
		client: { name: string } | null;
		appointment: {
			service_name: string;
			starts_at: string;
			price_cents: number;
			paid_cents: number;
			balance_cents: number;
		} | null;
	};
	const receipt = async (b: FinBase, id: string) => {
		const r = await req(b, "GET", `/v1/finance/transactions/${id}/receipt`);
		expect(r.status).toBe(200);
		return (await r.json()) as Receipt;
	};

	it("número sequencial estável por negócio, dados do atendimento sem contato do cliente", async () => {
		const b = await setup();
		const other = await setup();
		await sql`
      UPDATE businesses SET address_street = 'Rua A', address_number = '10',
        address_city = 'Bauru', address_state = 'SP'
      WHERE id = ${b.businessId}`;
		const a = await appt(b, localNoon(1), 10000);
		const deposit = await req(b, "POST", "/v1/finance/payments", {
			appointment_id: a,
			amount_cents: 3000,
			payment_method: "credit",
			installments: 2,
		});
		const { payment: p1 } = (await deposit.json()) as {
			payment: { id: string };
		};
		const walkIn = await income(b, null, 500);

		const r1 = await receipt(b, p1.id);
		expect(r1.number).toBe(1);
		expect(r1.payment).toMatchObject({
			amount_cents: 3000,
			payment_method: "credit",
			installments: 2,
			kind: "deposit",
		});
		expect(r1.business).toMatchObject({
			address: "Rua A, 10 — Bauru/SP",
			logo_url: null,
		});
		expect(r1.business.name).toContain(PREFIX);
		expect(r1.client).toEqual({ name: "Ana" });
		expect(r1.appointment).toMatchObject({
			service_name: "Escova",
			price_cents: 10000,
			paid_cents: 3000,
			balance_cents: 7000,
		});
		expect(JSON.stringify(r1)).not.toMatch(/phone|email|\+5511/);

		const r2 = await receipt(b, walkIn);
		expect(r2.number).toBe(2);
		expect(r2.client).toBeNull();
		expect(r2.appointment).toBeNull();
		expect((await receipt(b, p1.id)).number).toBe(1);

		const o = await income(other, null, 100);
		const ro = await receipt(other, o);
		expect(ro.number).toBe(1);
		expect(ro.business.address).toBeNull();
	});

	it("pedidos simultâneos recebem números diferentes", async () => {
		const b = await setup();
		const ids = await Promise.all([income(b, null, 100), income(b, null, 200)]);
		const nums = (await Promise.all(ids.map((id) => receipt(b, id)))).map(
			(r) => r.number,
		);
		expect(nums.sort()).toEqual([1, 2]);
	});

	it("logo do negócio vira URL pública", async () => {
		const b = await setup();
		await sql`
      UPDATE businesses SET logo_data = '\\x89504e47', logo_mime = 'image/png'
      WHERE id = ${b.businessId}`;
		const [biz] = await sql<{ slug: string }[]>`
      SELECT slug FROM businesses WHERE id = ${b.businessId}`;
		const r = await receipt(b, await income(b, null, 100));
		expect(r.business.logo_url).toBe(`/v1/businesses/${biz?.slug}/logo`);
	});

	it("estornado 409; despesa/suprimento/outro negócio 404; id inválido 400; conta vencida 200", async () => {
		const b = await setup();
		const other = await setup();
		const id = await income(b, null, 100);
		await req(b, "POST", `/v1/finance/transactions/${id}/void`);
		const r1 = await req(b, "GET", `/v1/finance/transactions/${id}/receipt`);
		expect(r1.status).toBe(409);
		expect(await errorOf(r1)).toBe(
			"Recebimento estornado não gera comprovante",
		);

		const e = await req(b, "POST", "/v1/finance/expenses", {
			amount_cents: 100,
			category: "taxas",
			payment_method: "pix",
		});
		const { expense } = (await e.json()) as { expense: { id: string } };
		const r2 = await req(
			b,
			"GET",
			`/v1/finance/transactions/${expense.id}/receipt`,
		);
		expect(r2.status).toBe(404);
		expect(await errorOf(r2)).toBe("Recebimento não encontrado");

		const ok = await income(b, null, 100);
		expect(
			(await req(other, "GET", `/v1/finance/transactions/${ok}/receipt`))
				.status,
		).toBe(404);
		expect(
			(await req(b, "GET", "/v1/finance/transactions/abc/receipt")).status,
		).toBe(400);

		await sql`
      UPDATE businesses SET subscription_status = 'trial',
        trial_ends_at = now() - interval '1 day' WHERE id = ${b.businessId}`;
		expect((await receipt(b, ok)).number).toBe(1);
	});
});
