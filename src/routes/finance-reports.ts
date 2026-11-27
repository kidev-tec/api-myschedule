/**
 * Módulo de finanças — Fase 3: relatórios e metas
 * (.planning/financas/SPEC.md, TASK-F3-01 e F3-02; RF-F07 a RF-F10).
 *
 * - GET /finance/reports/summary?from&to — faturamento (regime de caixa),
 *   despesas, resultado, por forma, série diária, ticket médio, em aberto
 * - GET /finance/reports/services?from&to — atendimentos concluídos por serviço
 * - GET|PUT|DELETE /finance/goals/:month — meta mensal ("YYYY-MM")
 *
 * Datas são DIAS LOCAIS do negócio ("YYYY-MM-DD"): o SQL converte com
 * AT TIME ZONE businesses.timezone. Faturamento (D1) = recebimentos
 * (payment/deposit) não anulados; suprimento/sangria nunca entram.
 * Por serviço e ticket médio (D10) = valor dos atendimentos concluídos.
 */

import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type Db, getDb } from "../db/connection.js";
import { businesses, financialGoals } from "../db/schema.js";
import {
	daysLeft,
	eachDay,
	monthRange,
	parseLocalDate,
	spanDays,
	toKey,
} from "../domain/report-period.js";
import { dayKey } from "../domain/schedule-day.js";
import type { AppEnv } from "../types.js";
import { amountCents, firstIssue, requireUser } from "./finance-shared.js";

const MAX_SPAN_DAYS = 366;

export const goalPutSchema = z.object({ target_cents: amountCents });

type Rows<T> = T[];

async function timezoneOf(db: Db, businessId: string): Promise<string> {
	const [b] = await db
		.select({ tz: businesses.timezone })
		.from(businesses)
		.where(eq(businesses.id, businessId))
		.limit(1);
	/* v8 ignore next -- business do usuário sempre existe (FK) */
	return b?.tz ?? "America/Sao_Paulo";
}

/** Período da query ou a mensagem de erro (PT-BR). */
function parsePeriod(
	q: Record<string, string>,
): { from: Date; to: Date } | { error: string } {
	const from = parseLocalDate(q.from);
	const to = parseLocalDate(q.to);
	if (!from || !to) return { error: "Data inválida (use AAAA-MM-DD)" };
	if (from > to) return { error: "A data inicial deve ser antes da final" };
	if (spanDays(from, to) > MAX_SPAN_DAYS) {
		return { error: `Período máximo: ${MAX_SPAN_DAYS} dias` };
	}
	return { from, to };
}

/** Recebimentos e despesas pagas por dia local, tipo e forma. */
async function ledgerByDay(
	db: Db,
	businessId: string,
	tz: string,
	from: Date,
	to: Date,
) {
	return (await db.execute(sql`
    WITH t AS (
      SELECT (occurred_at AT TIME ZONE ${tz})::date AS day, type,
             payment_method, amount_cents
      FROM transactions
      WHERE business_id = ${businessId}
        AND voided_at IS NULL
        AND ((type = 'income' AND kind IN ('payment', 'deposit'))
             OR (kind = 'expense' AND paid))
    )
    SELECT day::text AS day, type, payment_method, sum(amount_cents)::int AS total
    FROM t
    WHERE day BETWEEN ${toKey(from)}::date AND ${toKey(to)}::date
    GROUP BY 1, 2, 3`)) as unknown as Rows<{
		day: string;
		type: "income" | "expense";
		payment_method: string | null;
		total: number;
	}>;
}

/** Faturamento (regime de caixa) do período. */
async function revenue(
	db: Db,
	businessId: string,
	tz: string,
	from: Date,
	to: Date,
) {
	const rows = await ledgerByDay(db, businessId, tz, from, to);
	return rows
		.filter((r) => r.type === "income")
		.reduce((s, r) => s + r.total, 0);
}

/** Atendimentos concluídos no período (dia local do início). */
function doneAppointments(
	businessId: string,
	tz: string,
	from: Date,
	to: Date,
) {
	return sql`
    SELECT a.service_id, a.client_id, a.price_cents
    FROM appointments a
    WHERE a.business_id = ${businessId}
      AND a.status = 'done'
      AND a.source <> 'block'
      AND (a.starts_at AT TIME ZONE ${tz})::date
          BETWEEN ${toKey(from)}::date AND ${toKey(to)}::date`;
}

export function financeReportRoutes(databaseUrl: string) {
	const db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.get("/finance/reports/summary", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const p = parsePeriod(c.req.query());
		if ("error" in p) return c.json({ error: p.error }, 400);
		const tz = await timezoneOf(db, user.businessId);

		const rows = await ledgerByDay(db, user.businessId, tz, p.from, p.to);
		const series = new Map(
			eachDay(p.from, p.to).map((d) => [
				d,
				{ date: d, revenue_cents: 0, expenses_cents: 0 },
			]),
		);
		const byMethod: Record<string, number> = {};
		let revenueCents = 0;
		let expensesCents = 0;
		for (const r of rows) {
			const day = series.get(r.day) as {
				revenue_cents: number;
				expenses_cents: number;
			};
			if (r.type === "income") {
				revenueCents += r.total;
				day.revenue_cents += r.total;
				const m = r.payment_method ?? "other";
				byMethod[m] = (byMethod[m] ?? 0) + r.total;
			} else {
				expensesCents += r.total;
				day.expenses_cents += r.total;
			}
		}

		const [sold] = (await db.execute(sql`
      WITH d AS (${doneAppointments(user.businessId, tz, p.from, p.to)})
      SELECT count(*)::int AS n,
             COALESCE(sum(price_cents), 0)::int AS total,
             count(DISTINCT client_id)::int AS clients
      FROM d`)) as unknown as Rows<{
			n: number;
			total: number;
			clients: number;
		}>;
		/* v8 ignore next -- agregado sem GROUP BY sempre devolve 1 linha */
		const s = sold ?? { n: 0, total: 0, clients: 0 };

		// em aberto agora (mesma regra de /finance/receivables, janela +60 dias)
		const [open] = (await db.execute(sql`
      SELECT COALESCE(sum(a.price_cents - COALESCE(p.paid, 0)), 0)::int AS open
      FROM appointments a
      LEFT JOIN (
        SELECT appointment_id, sum(amount_cents) AS paid FROM transactions
        WHERE type = 'income' AND voided_at IS NULL AND appointment_id IS NOT NULL
        GROUP BY appointment_id
      ) p ON p.appointment_id = a.id
      WHERE a.business_id = ${user.businessId}
        AND a.status IN ('pending', 'confirmed', 'done')
        AND a.source <> 'block'
        AND a.starts_at <= now() + interval '60 days'
        AND a.price_cents > COALESCE(p.paid, 0)`)) as unknown as Rows<{
			open: number;
		}>;

		return c.json({
			from: toKey(p.from),
			to: toKey(p.to),
			revenue_cents: revenueCents,
			expenses_cents: expensesCents,
			result_cents: revenueCents - expensesCents,
			by_method: byMethod,
			series: [...series.values()],
			done_count: s.n,
			sold_cents: s.total,
			avg_ticket_cents: s.n ? Math.round(s.total / s.n) : 0,
			avg_per_client_cents: s.clients ? Math.round(s.total / s.clients) : 0,
			/* v8 ignore next -- agregado sem GROUP BY sempre devolve 1 linha */
			open_cents: open?.open ?? 0,
		});
	});

	routes.get("/finance/reports/services", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const p = parsePeriod(c.req.query());
		if ("error" in p) return c.json({ error: p.error }, 400);
		const tz = await timezoneOf(db, user.businessId);
		const items = (await db.execute(sql`
      WITH d AS (${doneAppointments(user.businessId, tz, p.from, p.to)})
      SELECT s.id AS service_id, s.name AS service_name, s.is_kit,
             count(*)::int AS count, sum(d.price_cents)::int AS total_cents
      FROM d JOIN services s ON s.id = d.service_id
      GROUP BY s.id, s.name, s.is_kit
      ORDER BY total_cents DESC, s.name`)) as unknown as Rows<unknown>;
		return c.json({ items: [...items] });
	});

	/** Meta + realizado de um mês ("YYYY-MM"). */
	async function goalOf(businessId: string, month: string) {
		const range = monthRange(month) as [Date, Date];
		const tz = await timezoneOf(db, businessId);
		const [g] = await db
			.select({ target: financialGoals.targetCents })
			.from(financialGoals)
			.where(
				and(
					eq(financialGoals.businessId, businessId),
					eq(financialGoals.month, toKey(range[0])),
				),
			)
			.limit(1);
		const achieved = await revenue(db, businessId, tz, range[0], range[1]);
		const target = g?.target ?? null;
		const remaining = target === null ? 0 : Math.max(target - achieved, 0);
		const left = daysLeft(range, dayKey(new Date(), tz));
		return {
			month,
			target_cents: target,
			achieved_cents: achieved,
			percent: target === null ? null : Math.floor((achieved * 100) / target),
			remaining_cents: remaining,
			days_left: left,
			needed_per_day_cents: left ? Math.ceil(remaining / left) : 0,
		};
	}

	routes.get("/finance/goals/:month", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const month = c.req.param("month");
		if (!monthRange(month)) {
			return c.json({ error: "Mês inválido (use AAAA-MM)" }, 400);
		}
		return c.json(await goalOf(user.businessId, month));
	});

	routes.put("/finance/goals/:month", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const month = c.req.param("month");
		const range = monthRange(month);
		if (!range) return c.json({ error: "Mês inválido (use AAAA-MM)" }, 400);
		const raw = await c.req.json().catch(() => undefined);
		if (raw === undefined) return c.json({ error: "Dados inválidos" }, 400);
		const parsed = goalPutSchema.safeParse(raw);
		if (!parsed.success) {
			return c.json({ error: firstIssue(parsed.error) }, 400);
		}
		await db
			.insert(financialGoals)
			.values({
				businessId: user.businessId,
				month: toKey(range[0]),
				targetCents: parsed.data.target_cents,
			})
			.onConflictDoUpdate({
				target: [financialGoals.businessId, financialGoals.month],
				set: { targetCents: parsed.data.target_cents, updatedAt: new Date() },
			});
		return c.json(await goalOf(user.businessId, month));
	});

	routes.delete("/finance/goals/:month", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const month = c.req.param("month");
		const range = monthRange(month);
		if (!range) return c.json({ error: "Mês inválido (use AAAA-MM)" }, 400);
		await db
			.delete(financialGoals)
			.where(
				and(
					eq(financialGoals.businessId, user.businessId),
					eq(financialGoals.month, toKey(range[0])),
				),
			);
		return c.json(await goalOf(user.businessId, month));
	});

	return routes;
}
