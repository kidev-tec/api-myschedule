/**
 * Integração REAL: recebimentos, estorno e contas a receber
 * (módulo de finanças, TASK-F1-03 — RF-F01, RF-F02, RF-F04).
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

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = 0;
const uid = () => `fin-uid-${Date.now()}-${seq++}`;

/** Vários usuários válidos ao mesmo tempo (token = uid). */
const known = new Set<string>();
verifyMock.mockImplementation(async (token: string) => {
	if (!known.has(token)) throw new Error("invalid");
	return { uid: token, email: `${token}@t.com`, name: "Pro Fin" };
});

type Base = {
	h: Record<string, string>;
	businessId: string;
	clientId: string;
	serviceId: string;
};

async function setup(): Promise<Base> {
	const u = uid();
	known.add(u);
	const h = { Authorization: `Bearer ${u}` };
	const res = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({ name: `Pro Fin ${u}` }),
	});
	expect(res.status).toBe(201);
	const [me] = await sql<{ businessId: string }[]>`
    SELECT b.id AS "businessId" FROM businesses b
    JOIN users u ON u.business_id = b.id WHERE u.firebase_uid = ${u}`;
	if (!me) throw new Error("negócio não criado");
	const [client] = await sql<{ id: string }[]>`
    INSERT INTO clients (business_id, name, phone_e164)
    VALUES (${me.businessId}, 'Ana', ${`+55119${String(20000000 + seq).slice(0, 8)}`})
    RETURNING id`;
	const [service] = await sql<{ id: string }[]>`
    INSERT INTO services (business_id, name, duration_min, price_cents)
    VALUES (${me.businessId}, 'Escova', 30, 10000) RETURNING id`;
	if (!client || !service) throw new Error("fixtures");
	return { h, ...me, clientId: client.id, serviceId: service.id };
}

const HOUR = 3600_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

function req(
	h: Record<string, string>,
	method: string,
	path: string,
	body?: unknown,
) {
	return app.request(path, {
		method,
		headers: { "content-type": "application/json", ...h },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

/** Agendamento via API (preço R$ 100); status ajustado direto no banco. */
async function appt(b: Base, msFromNow: number, status?: string) {
	const startsAt = iso(msFromNow);
	const res = await req(b.h, "POST", "/v1/appointments", {
		clientId: b.clientId,
		serviceId: b.serviceId,
		startsAt,
		endsAt: new Date(new Date(startsAt).getTime() + 1800_000).toISOString(),
	});
	expect(res.status).toBe(201);
	const { appointment } = (await res.json()) as {
		appointment: { id: string };
	};
	if (status) {
		await sql`UPDATE appointments SET status = ${status} WHERE id = ${appointment.id}`;
	}
	return appointment.id;
}

type Finance = {
	appointment_id: string;
	price_cents: number;
	paid_cents: number;
	balance_cents: number;
	payment_status: string;
};
type Payment = {
	id: string;
	amount_cents: number;
	payment_method: string;
	installments: number;
	kind: string;
	client_id: string | null;
	voided_at: string | null;
};

async function pay(b: Base, body: Record<string, unknown>) {
	return req(b.h, "POST", "/v1/finance/payments", body);
}
async function errorOf(res: Response) {
	return ((await res.json()) as { error: string }).error;
}

afterAll(async () => {
	const biz = sql`SELECT id FROM businesses WHERE name LIKE 'Pro Fin%'`;
	await sql`DELETE FROM transactions WHERE business_id IN (${biz})`;
	await sql`DELETE FROM appointments WHERE business_id IN (${biz})`;
	await sql`DELETE FROM clients WHERE business_id IN (${biz})`;
	await sql`DELETE FROM users WHERE email LIKE 'fin-uid-%'`;
	await sql`DELETE FROM services WHERE business_id IN (${biz})`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro Fin%'`;
	await sql.end();
});

describe("RF-F02 — sinal, parcial e quitação", () => {
	it("sinal antes do atendimento, quitação e excesso", async () => {
		const b = await setup();
		const id = await appt(b, 48 * HOUR);

		const r1 = await pay(b, {
			appointment_id: id,
			amount_cents: 3000,
			payment_method: "pix",
		});
		expect(r1.status).toBe(201);
		const b1 = (await r1.json()) as { payment: Payment; appointment: Finance };
		expect(b1.payment).toMatchObject({
			amount_cents: 3000,
			payment_method: "pix",
			installments: 1,
			kind: "deposit",
			client_id: b.clientId,
		});
		expect(b1.appointment).toEqual({
			appointment_id: id,
			price_cents: 10000,
			paid_cents: 3000,
			balance_cents: 7000,
			payment_status: "partial",
		});

		const r2 = await pay(b, {
			appointment_id: id,
			amount_cents: 7000,
			payment_method: "cash",
		});
		expect(r2.status).toBe(201);
		expect(
			((await r2.json()) as { appointment: Finance }).appointment
				.payment_status,
		).toBe("paid");

		const r3 = await pay(b, {
			appointment_id: id,
			amount_cents: 1,
			payment_method: "cash",
		});
		expect(r3.status).toBe(422);
		expect(await errorOf(r3)).toBe("Este agendamento já está pago");
	});

	it("valor acima do saldo → 422 com o saldo em reais", async () => {
		const b = await setup();
		const id = await appt(b, 50 * HOUR);
		const r = await pay(b, {
			appointment_id: id,
			amount_cents: 10001,
			payment_method: "debit",
		});
		expect(r.status).toBe(422);
		expect(await errorOf(r)).toBe(
			"Valor maior que o saldo restante (R$ 100,00)",
		);
	});

	it("atendimento concluído (passado) recebe como pagamento, não sinal", async () => {
		const b = await setup();
		const id = await appt(b, -3 * HOUR, "done");
		const r = await pay(b, {
			appointment_id: id,
			amount_cents: 10000,
			payment_method: "credit",
			installments: 3,
		});
		expect(r.status).toBe(201);
		const body = (await r.json()) as { payment: Payment };
		expect(body.payment.kind).toBe("payment");
		expect(body.payment.installments).toBe(3);
	});

	it("dois recebimentos simultâneos não passam do saldo", async () => {
		const b = await setup();
		const id = await appt(b, 52 * HOUR);
		const body = {
			appointment_id: id,
			amount_cents: 6000,
			payment_method: "pix",
		};
		const statuses = (await Promise.all([pay(b, body), pay(b, body)]))
			.map((r) => r.status)
			.sort();
		expect(statuses).toEqual([201, 422]);
	});

	it("agendamento cancelado → 422; de outro negócio → 404", async () => {
		const b = await setup();
		const other = await setup();
		const canceled = await appt(b, 54 * HOUR, "canceled");
		const r1 = await pay(b, {
			appointment_id: canceled,
			amount_cents: 100,
			payment_method: "pix",
		});
		expect(r1.status).toBe(422);
		expect(await errorOf(r1)).toBe(
			"Agendamento cancelado não recebe pagamento",
		);

		const foreign = await appt(other, 56 * HOUR);
		const r2 = await pay(b, {
			appointment_id: foreign,
			amount_cents: 100,
			payment_method: "pix",
		});
		expect(r2.status).toBe(404);
		expect(await errorOf(r2)).toBe("Agendamento não encontrado");
	});

	it("bloqueio de horário não recebe pagamento (sem valor)", async () => {
		const b = await setup();
		const res = await req(b.h, "POST", "/v1/appointments", {
			startsAt: iso(58 * HOUR),
			endsAt: iso(59 * HOUR),
			source: "block",
		});
		const { appointment } = (await res.json()) as {
			appointment: { id: string };
		};
		const r = await pay(b, {
			appointment_id: appointment.id,
			amount_cents: 100,
			payment_method: "pix",
		});
		expect(r.status).toBe(422);
		expect(await errorOf(r)).toBe("Este agendamento não tem valor a receber");
	});
});

describe("RF-F01 — validação do recebimento", () => {
	it.each([
		[{ amount_cents: 0, payment_method: "pix" }, "Valor inválido"],
		[{ amount_cents: 1.5, payment_method: "pix" }, "Valor inválido"],
		[
			{ amount_cents: 100, payment_method: "boleto" },
			"Forma de pagamento inválida",
		],
		[{ amount_cents: 100 }, "Forma de pagamento inválida"],
		[
			{ amount_cents: 100, payment_method: "credit", installments: 13 },
			"Parcelas: de 1 a 12",
		],
		[
			{ amount_cents: 100, payment_method: "pix", installments: 2 },
			"Parcelamento só no crédito",
		],
		[
			{ amount_cents: 100, payment_method: "pix", appointment_id: "x" },
			"Registro inválido",
		],
		[
			{ amount_cents: 100, payment_method: "pix", occurred_at: "ontem" },
			"Data inválida",
		],
		[
			{ amount_cents: 100, payment_method: "pix", notes: "a".repeat(501) },
			"Observações: no máximo 500 caracteres",
		],
	])("%j → 400 %s", async (body, message) => {
		const b = await setup();
		const r = await pay(b, body);
		expect(r.status).toBe(400);
		expect(await errorOf(r)).toBe(message);
	});

	it("body quebrado → 400", async () => {
		const b = await setup();
		const r = await app.request("/v1/finance/payments", {
			method: "POST",
			headers: { "content-type": "application/json", ...b.h },
			body: "{",
		});
		expect(r.status).toBe(400);
		expect(await errorOf(r)).toBe("Dados inválidos");
	});
});

describe("RF-F01 — recebimento avulso (D7)", () => {
	it("sem cliente e com cliente do negócio; cliente de fora → 404", async () => {
		const b = await setup();
		const other = await setup();
		const r1 = await pay(b, {
			amount_cents: 2500,
			payment_method: "cash",
			notes: "Venda de produto",
			occurred_at: iso(-HOUR),
		});
		expect(r1.status).toBe(201);
		const b1 = (await r1.json()) as {
			payment: Payment;
			appointment: Finance | null;
		};
		expect(b1.payment).toMatchObject({ kind: "payment", client_id: null });
		expect(b1.appointment).toBeNull();
		const [row] = await sql<{ category: string }[]>`
      SELECT category FROM transactions WHERE id = ${b1.payment.id}`;
		expect(row?.category).toBe("avulso");

		const r2 = await pay(b, {
			amount_cents: 1000,
			payment_method: "payment_link",
			client_id: b.clientId,
		});
		expect(r2.status).toBe(201);

		const r3 = await pay(b, {
			amount_cents: 1000,
			payment_method: "other",
			client_id: other.clientId,
		});
		expect(r3.status).toBe(404);
		expect(await errorOf(r3)).toBe("Cliente não encontrado");
	});
});

describe("RF-F02 — detalhe e estorno", () => {
	it("detalhe lista recebimentos; estorno volta a situação; 2º estorno 409", async () => {
		const b = await setup();
		const id = await appt(b, 60 * HOUR);
		const r = await pay(b, {
			appointment_id: id,
			amount_cents: 4000,
			payment_method: "pix",
			notes: "sinal",
		});
		const { payment } = (await r.json()) as { payment: Payment };

		const d1 = await req(b.h, "GET", `/v1/finance/appointments/${id}`);
		expect(d1.status).toBe(200);
		const det = (await d1.json()) as Finance & { payments: Payment[] };
		expect(det).toMatchObject({ paid_cents: 4000, payment_status: "partial" });
		expect(det.payments).toHaveLength(1);
		expect(det.payments[0]).toMatchObject({ id: payment.id, voided_at: null });

		const v1 = await req(
			b.h,
			"POST",
			`/v1/finance/transactions/${payment.id}/void`,
		);
		expect(v1.status).toBe(200);
		const vb = (await v1.json()) as {
			payment: Payment;
			appointment: Finance;
		};
		expect(vb.payment.voided_at).not.toBeNull();
		expect(vb.appointment.payment_status).toBe("open");

		const v2 = await req(
			b.h,
			"POST",
			`/v1/finance/transactions/${payment.id}/void`,
		);
		expect(v2.status).toBe(409);
		expect(await errorOf(v2)).toBe("Este lançamento já foi estornado");

		// estornado continua listado no detalhe (histórico)
		const d2 = (await (
			await req(b.h, "GET", `/v1/finance/appointments/${id}`)
		).json()) as Finance & { payments: Payment[] };
		expect(d2.paid_cents).toBe(0);
		expect(d2.payments[0]?.voided_at).not.toBeNull();
	});

	it("estorno de avulso devolve appointment null", async () => {
		const b = await setup();
		const r = await pay(b, { amount_cents: 500, payment_method: "cash" });
		const { payment } = (await r.json()) as { payment: Payment };
		const v = await req(
			b.h,
			"POST",
			`/v1/finance/transactions/${payment.id}/void`,
		);
		expect(v.status).toBe(200);
		expect(((await v.json()) as { appointment: null }).appointment).toBeNull();
	});

	it("de outro negócio ou id inválido → 404 / 400", async () => {
		const b = await setup();
		const other = await setup();
		const id = await appt(other, 62 * HOUR);
		const r = await pay(other, {
			appointment_id: id,
			amount_cents: 100,
			payment_method: "pix",
		});
		const { payment } = (await r.json()) as { payment: Payment };

		expect(
			(await req(b.h, "GET", `/v1/finance/appointments/${id}`)).status,
		).toBe(404);
		const v = await req(
			b.h,
			"POST",
			`/v1/finance/transactions/${payment.id}/void`,
		);
		expect(v.status).toBe(404);
		expect(await errorOf(v)).toBe("Lançamento não encontrado");
		expect((await req(b.h, "GET", "/v1/finance/appointments/abc")).status).toBe(
			400,
		);
		expect(
			(await req(b.h, "POST", "/v1/finance/transactions/abc/void")).status,
		).toBe(400);
	});
});

describe("RF-F04 — contas a receber", () => {
	type Receivables = {
		items: (Finance & {
			id: string;
			status: string;
			client_name: string;
			service_name: string;
		})[];
		total_open_cents: number;
		overdue_cents: number;
		upcoming_cents: number;
	};

	it("atrasados e próximos com saldo; exclui cancelado, falta, pago e bloqueio", async () => {
		const b = await setup();
		const done = await appt(b, -5 * HOUR, "done"); // atrasado, R$ 100
		const future = await appt(b, 70 * HOUR); // próximo, R$ 100 − 40
		await pay(b, {
			appointment_id: future,
			amount_cents: 4000,
			payment_method: "pix",
		});
		const paidOff = await appt(b, 72 * HOUR);
		await pay(b, {
			appointment_id: paidOff,
			amount_cents: 10000,
			payment_method: "pix",
		});
		await appt(b, 74 * HOUR, "canceled");
		await appt(b, -8 * HOUR, "noshow");
		await req(b.h, "POST", "/v1/appointments", {
			startsAt: iso(76 * HOUR),
			endsAt: iso(77 * HOUR),
			source: "block",
		});
		const free = await appt(b, 78 * HOUR);
		await req(b.h, "PATCH", `/v1/appointments/${free}`, { price_cents: 0 });

		const r = await req(b.h, "GET", "/v1/finance/receivables");
		expect(r.status).toBe(200);
		const body = (await r.json()) as Receivables;
		expect(body.items.map((i) => i.id)).toEqual([done, future]);
		expect(body.items[0]).toMatchObject({
			status: "done",
			client_name: "Ana",
			service_name: "Escova",
			balance_cents: 10000,
			payment_status: "open",
		});
		expect(body.items[1]).toMatchObject({
			balance_cents: 6000,
			payment_status: "partial",
		});
		expect(body.total_open_cents).toBe(16000);
		expect(body.overdue_cents).toBe(10000);
		expect(body.upcoming_cents).toBe(6000);
	});

	it("filtra por período e cliente", async () => {
		const b = await setup();
		const near = await appt(b, 80 * HOUR);
		await appt(b, 200 * HOUR);
		const [other] = await sql<{ id: string }[]>`
      INSERT INTO clients (business_id, name, phone_e164)
      VALUES (${b.businessId}, 'Bia', ${`+55119${String(30000000 + seq).slice(0, 8)}`})
      RETURNING id`;

		const q = `from=${encodeURIComponent(iso(79 * HOUR))}&to=${encodeURIComponent(iso(81 * HOUR))}`;
		const r1 = (await (
			await req(b.h, "GET", `/v1/finance/receivables?${q}`)
		).json()) as Receivables;
		expect(r1.items.map((i) => i.id)).toEqual([near]);

		const r2 = (await (
			await req(b.h, "GET", `/v1/finance/receivables?client_id=${other?.id}`)
		).json()) as Receivables;
		expect(r2.items).toEqual([]);
		expect(r2.total_open_cents).toBe(0);

		expect(
			(await req(b.h, "GET", "/v1/finance/receivables?from=ontem")).status,
		).toBe(400);
		expect(
			(await req(b.h, "GET", "/v1/finance/receivables?client_id=x")).status,
		).toBe(400);
	});
});

describe("paywall", () => {
	it("conta vencida: lança 402, consulta 200", async () => {
		const b = await setup();
		const id = await appt(b, 90 * HOUR);
		await sql`
      UPDATE businesses SET subscription_status = 'trial',
        trial_ends_at = now() - interval '1 day'
      WHERE id = ${b.businessId}`;
		const r = await pay(b, {
			appointment_id: id,
			amount_cents: 100,
			payment_method: "pix",
		});
		expect(r.status).toBe(402);
		expect(
			(await req(b.h, "GET", `/v1/finance/appointments/${id}`)).status,
		).toBe(200);
		expect((await req(b.h, "GET", "/v1/finance/receivables")).status).toBe(200);
	});
});
