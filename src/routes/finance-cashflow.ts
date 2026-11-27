/**
 * Módulo de finanças — Fase 4: fluxo de caixa projetado e comprovante
 * (.planning/financas/SPEC.md, TASK-F4-01 e F4-02; RF-F11, RF-F12).
 *
 * - GET /finance/cashflow?days=30 — previsão dia a dia (dias locais do
 *   negócio): entradas = saldo dos agendamentos pendentes/confirmados no dia
 *   do atendimento; saídas = despesas a pagar no vencimento. Atrasados à
 *   parte. Saldo acumulado a partir de 0 (o Agenva não conhece o saldo
 *   bancário).
 * - GET /finance/transactions/:id/receipt — dados do comprovante; atribui o
 *   número sequencial por negócio na 1ª emissão (idempotente).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/connection.js";
import { paidCentsOf } from "../db/finance-queries.js";
import {
	appointments,
	businesses,
	clients,
	services,
	transactions,
} from "../db/schema.js";
import { paymentStatus } from "../domain/payment-status.js";
import { eachDay, parseLocalDate } from "../domain/report-period.js";
import { dayKey } from "../domain/schedule-day.js";
import type { AppEnv } from "../types.js";
import { EXPENSE_LABELS } from "./finance-expenses.js";
import { HttpError, requireUser, uuidSchema } from "./finance-shared.js";

type Rows<T> = T[];

export function financeCashflowRoutes(databaseUrl: string) {
	const db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.get("/finance/cashflow", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const raw = c.req.query("days") ?? "30";
		const days = /^\d+$/.test(raw) ? Number(raw) : 0;
		if (days < 1 || days > 90) {
			return c.json({ error: "Período inválido (1 a 90 dias)" }, 400);
		}
		const [biz] = await db
			.select({ tz: businesses.timezone })
			.from(businesses)
			.where(eq(businesses.id, user.businessId))
			.limit(1);
		/* v8 ignore next -- business do usuário sempre existe (FK) */
		const tz = biz?.tz ?? "America/Sao_Paulo";
		const from = parseLocalDate(dayKey(new Date(), tz)) as Date;
		const to = new Date(from.getTime() + (days - 1) * 86_400_000);
		const fromKey = from.toISOString().slice(0, 10);
		const toKey = to.toISOString().slice(0, 10);

		const inflow = (await db.execute(sql`
      WITH a AS (
        SELECT a.id, (a.starts_at AT TIME ZONE ${tz})::date AS day,
               a.status, c.name AS client, s.name AS service,
               a.price_cents - COALESCE((
                 SELECT sum(t.amount_cents) FROM transactions t
                 WHERE t.appointment_id = a.id AND t.type = 'income'
                   AND t.voided_at IS NULL), 0) AS balance
        FROM appointments a
        JOIN clients c ON c.id = a.client_id
        JOIN services s ON s.id = a.service_id
        WHERE a.business_id = ${user.businessId}
          AND a.source <> 'block'
          AND a.status IN ('pending', 'confirmed', 'done')
      )
      SELECT id, day::text AS day, status, client, service, balance::int AS balance
      FROM a
      WHERE balance > 0
        AND (day < ${fromKey}::date
             OR (status IN ('pending', 'confirmed')
                 AND day BETWEEN ${fromKey}::date AND ${toKey}::date))
      ORDER BY day, client`)) as unknown as Rows<{
			id: string;
			day: string;
			status: string;
			client: string;
			service: string;
			balance: number;
		}>;

		const outflow = (await db.execute(sql`
      SELECT id, (due_at AT TIME ZONE ${tz})::date::text AS day,
             category, notes, amount_cents
      FROM transactions
      WHERE business_id = ${user.businessId}
        AND kind = 'expense' AND NOT paid AND voided_at IS NULL
        AND due_at IS NOT NULL
        AND (due_at AT TIME ZONE ${tz})::date <= ${toKey}::date
      ORDER BY due_at`)) as unknown as Rows<{
			id: string;
			day: string;
			category: string;
			notes: string | null;
			amount_cents: number;
		}>;

		type Item = {
			kind: "appointment" | "expense";
			id: string;
			label: string;
			amount_cents: number;
		};
		const byDay = new Map(
			eachDay(from, to).map((d) => [
				d,
				{ inflow: 0, outflow: 0, items: [] as Item[] },
			]),
		);
		let overdueIn = 0;
		let overdueOut = 0;
		for (const r of inflow) {
			const d = byDay.get(r.day);
			if (!d) {
				overdueIn += r.balance; // passado (fora da janela)
				continue;
			}
			d.inflow += r.balance;
			d.items.push({
				kind: "appointment",
				id: r.id,
				label: `${r.client} • ${r.service}`,
				amount_cents: r.balance,
			});
		}
		for (const r of outflow) {
			const d = byDay.get(r.day);
			if (!d) {
				overdueOut += r.amount_cents; // vencida
				continue;
			}
			d.outflow += r.amount_cents;
			d.items.push({
				kind: "expense",
				id: r.id,
				/* v8 ignore next -- categoria fora da lista só em dado antigo */
				label: r.notes ?? EXPENSE_LABELS[r.category] ?? r.category,
				amount_cents: r.amount_cents,
			});
		}

		let balance = 0;
		let inTotal = 0;
		let outTotal = 0;
		const series = [...byDay.entries()].map(([date, d]) => {
			balance += d.inflow - d.outflow;
			inTotal += d.inflow;
			outTotal += d.outflow;
			return {
				date,
				inflow_cents: d.inflow,
				outflow_cents: d.outflow,
				balance_cents: balance,
				items: d.items,
			};
		});
		return c.json({
			from: fromKey,
			to: toKey,
			inflow_cents: inTotal,
			outflow_cents: outTotal,
			net_cents: inTotal - outTotal,
			overdue_in_cents: overdueIn,
			overdue_out_cents: overdueOut,
			days: series,
		});
	});

	routes.get("/finance/transactions/:id/receipt", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const id = c.req.param("id");
		if (!uuidSchema.safeParse(id).success) {
			return c.json({ error: "Registro inválido" }, 400);
		}
		try {
			const result = await db.transaction(async (tx) => {
				const [t] = await tx
					.select()
					.from(transactions)
					.where(
						and(
							eq(transactions.id, id),
							eq(transactions.businessId, user.businessId),
							eq(transactions.type, "income"),
							inArray(transactions.kind, ["payment", "deposit"]),
						),
					)
					.limit(1);
				if (!t) throw new HttpError(404, "Recebimento não encontrado");
				if (t.voidedAt) {
					throw new HttpError(
						409,
						"Recebimento estornado não gera comprovante",
					);
				}
				// trava o negócio: emissões simultâneas recebem números distintos
				const [biz] = await tx
					.select()
					.from(businesses)
					.where(eq(businesses.id, user.businessId))
					.for("update");
				/* v8 ignore next -- business do usuário sempre existe (FK) */
				if (!biz) throw new Error("negócio desapareceu");
				let number = t.receiptNumber;
				if (number === null) {
					const [max] = await tx
						.select({
							n: sql<number>`COALESCE(max(${transactions.receiptNumber}), 0)::int`,
						})
						.from(transactions)
						.where(eq(transactions.businessId, user.businessId));
					/* v8 ignore next -- agregado sempre devolve 1 linha */
					number = (max?.n ?? 0) + 1;
					await tx
						.update(transactions)
						.set({ receiptNumber: number })
						.where(eq(transactions.id, t.id));
				}

				const [client] = t.clientId
					? await tx
							.select({ name: clients.name })
							.from(clients)
							.where(eq(clients.id, t.clientId))
					: [];
				let appointment = null;
				if (t.appointmentId) {
					const [a] = await tx
						.select({
							startsAt: appointments.startsAt,
							priceCents: appointments.priceCents,
							service: services.name,
						})
						.from(appointments)
						.innerJoin(services, eq(services.id, appointments.serviceId))
						.where(eq(appointments.id, t.appointmentId));
					/* v8 ignore next -- FK garante o agendamento */
					if (a) {
						const fin = paymentStatus(
							a.priceCents,
							await paidCentsOf(tx, t.appointmentId),
						);
						appointment = {
							service_name: a.service,
							starts_at: a.startsAt,
							price_cents: fin.price_cents,
							paid_cents: fin.paid_cents,
							balance_cents: fin.balance_cents,
						};
					}
				}
				const street = [biz.addressStreet, biz.addressNumber]
					.filter(Boolean)
					.join(", ");
				const city = [biz.addressCity, biz.addressState]
					.filter(Boolean)
					.join("/");
				const address = [street, city].filter(Boolean).join(" — ") || null;
				return {
					number,
					payment: {
						id: t.id,
						amount_cents: t.amountCents,
						payment_method: t.paymentMethod,
						installments: t.installments,
						kind: t.kind,
						occurred_at: t.occurredAt,
						notes: t.notes,
					},
					business: {
						name: biz.name,
						address,
						logo_url: biz.logoMime ? `/v1/businesses/${biz.slug}/logo` : null,
					},
					client: client ? { name: client.name } : null,
					appointment,
				};
			});
			return c.json(result);
		} catch (err) {
			/* v8 ignore next -- falha inesperada do banco: handler global (500) */
			if (!(err instanceof HttpError)) throw err;
			return c.json({ error: err.message }, err.status);
		}
	});

	return routes;
}
