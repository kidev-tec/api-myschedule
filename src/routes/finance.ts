/**
 * Módulo de finanças — Fase 1: cobrança do atendimento
 * (.planning/financas/SPEC.md, TASK-F1-03; RF-F01, RF-F02, RF-F04).
 *
 * - GET  /finance/appointments/:id      — valor, recebimentos e situação
 * - POST /finance/payments              — sinal / parcial / quitação / avulso
 * - POST /finance/transactions/:id/void — estorno (nunca apaga)
 * - GET  /finance/receivables           — agendamentos com saldo em aberto
 *
 * O livro-caixa é `transactions`; a situação é sempre derivada (SPEC §2).
 * Escrita passa pelo paywall global de app.ts (POST fora de readOnlyPaths).
 */

import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type Db, getDb } from "../db/connection.js";
import { paidCentsOf, paidCentsSql } from "../db/finance-queries.js";
import { appointments, clients, services, transactions } from "../db/schema.js";
import {
	type AppointmentFinance,
	formatBRL,
	paymentStatus,
} from "../domain/payment-status.js";
import type { AppEnv } from "../types.js";
import {
	amountCents,
	cleanNotes,
	firstIssue,
	HttpError,
	isoDate,
	notes,
	openCashSessionId,
	paymentMethod,
	requireUser,
	uuidSchema,
} from "./finance-shared.js";

/** Janela padrão de "A receber": tudo em aberto até 60 dias à frente. */
const RECEIVABLES_AHEAD_MS = 60 * 24 * 3600 * 1000;

export const paymentCreateSchema = z
	.object({
		appointment_id: z.uuid("Registro inválido").optional(),
		client_id: z.uuid("Registro inválido").optional(),
		amount_cents: amountCents,
		payment_method: paymentMethod,
		installments: z
			.int("Parcelas: de 1 a 12")
			.min(1, "Parcelas: de 1 a 12")
			.max(12, "Parcelas: de 1 a 12")
			.optional(),
		occurred_at: isoDate.optional(),
		notes: notes.optional(),
	})
	.refine(
		(b) => (b.installments ?? 1) === 1 || b.payment_method === "credit",
		"Parcelamento só no crédito",
	);

export const receivablesQuerySchema = z.object({
	from: isoDate.optional(),
	to: isoDate.optional(),
	client_id: z.uuid("Registro inválido").optional(),
});

type Payment = typeof transactions.$inferSelect;

function paymentJson(t: Payment) {
	return {
		id: t.id,
		appointment_id: t.appointmentId,
		client_id: t.clientId,
		amount_cents: t.amountCents,
		payment_method: t.paymentMethod,
		installments: t.installments,
		kind: t.kind,
		occurred_at: t.occurredAt,
		notes: t.notes,
		voided_at: t.voidedAt,
		created_at: t.createdAt,
	};
}

type Reader = Pick<Db, "select">;

async function financeOf(
	db: Reader,
	appointmentId: string,
	priceCents: number,
): Promise<AppointmentFinance & { appointment_id: string }> {
	return {
		appointment_id: appointmentId,
		...paymentStatus(priceCents, await paidCentsOf(db, appointmentId)),
	};
}

export function financeRoutes(databaseUrl: string) {
	const db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.get("/finance/appointments/:id", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const id = c.req.param("id");
		if (!uuidSchema.safeParse(id).success) {
			return c.json({ error: "Registro inválido" }, 400);
		}
		const [appt] = await db
			.select({ id: appointments.id, priceCents: appointments.priceCents })
			.from(appointments)
			.where(
				and(
					eq(appointments.id, id),
					eq(appointments.businessId, user.businessId),
				),
			)
			.limit(1);
		if (!appt) return c.json({ error: "Agendamento não encontrado" }, 404);
		const rows = await db
			.select()
			.from(transactions)
			.where(eq(transactions.appointmentId, id))
			.orderBy(asc(transactions.occurredAt), asc(transactions.createdAt));
		return c.json({
			...(await financeOf(db, id, appt.priceCents)),
			payments: rows.map(paymentJson),
		});
	});

	routes.post("/finance/payments", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const raw = await c.req.json().catch(() => undefined);
		if (raw === undefined) return c.json({ error: "Dados inválidos" }, 400);
		const parsed = paymentCreateSchema.safeParse(raw);
		if (!parsed.success) {
			return c.json({ error: firstIssue(parsed.error) }, 400);
		}
		const body = parsed.data;
		const occurredAt = body.occurred_at
			? new Date(body.occurred_at)
			: new Date();

		try {
			const result = await db.transaction(async (tx) => {
				let clientId = body.client_id ?? null;
				let kind = "payment";
				let appt: {
					id: string;
					priceCents: number;
					status: string;
					startsAt: Date;
					clientId: string;
				} | null = null;

				if (body.appointment_id) {
					// trava a linha: recebimentos simultâneos são serializados
					// e nunca ultrapassam o saldo
					const [row] = await tx
						.select({
							id: appointments.id,
							priceCents: appointments.priceCents,
							status: appointments.status,
							startsAt: appointments.startsAt,
							clientId: appointments.clientId,
						})
						.from(appointments)
						.where(
							and(
								eq(appointments.id, body.appointment_id),
								eq(appointments.businessId, user.businessId),
							),
						)
						.for("update");
					if (!row) throw new HttpError(404, "Agendamento não encontrado");
					if (row.status === "canceled") {
						throw new HttpError(
							422,
							"Agendamento cancelado não recebe pagamento",
						);
					}
					if (row.priceCents === 0) {
						throw new HttpError(
							422,
							"Este agendamento não tem valor a receber",
						);
					}
					const paid = await paidCentsOf(tx, row.id);
					const balance = row.priceCents - paid;
					if (balance <= 0) {
						throw new HttpError(422, "Este agendamento já está pago");
					}
					if (body.amount_cents > balance) {
						throw new HttpError(
							422,
							`Valor maior que o saldo restante (${formatBRL(balance)})`,
						);
					}
					appt = row;
					clientId = row.clientId;
					// sinal = pago antes do atendimento ainda ativo
					if (
						occurredAt < row.startsAt &&
						(row.status === "pending" || row.status === "confirmed")
					) {
						kind = "deposit";
					}
				} else if (clientId) {
					const [cli] = await tx
						.select({ id: clients.id })
						.from(clients)
						.where(
							and(
								eq(clients.id, clientId),
								eq(clients.businessId, user.businessId),
							),
						)
						.limit(1);
					if (!cli) throw new HttpError(404, "Cliente não encontrado");
				}

				const [created] = await tx
					.insert(transactions)
					.values({
						businessId: user.businessId,
						type: "income",
						amountCents: body.amount_cents,
						category: appt ? "atendimento" : "avulso",
						appointmentId: appt?.id ?? null,
						clientId,
						paymentMethod: body.payment_method,
						installments: body.installments ?? 1,
						kind,
						occurredAt,
						notes: cleanNotes(body.notes),
						createdByUserId: user.id,
						// 0028: caixa aberto no momento do recebimento
						cashSessionId: await openCashSessionId(tx, user.businessId),
					})
					.returning();
				/* v8 ignore next -- INSERT..RETURNING nunca é vazio */
				if (!created) throw new Error("falha ao registrar recebimento");
				return {
					payment: paymentJson(created),
					appointment: appt
						? await financeOf(tx, appt.id, appt.priceCents)
						: null,
				};
			});
			return c.json(result, 201);
		} catch (err) {
			/* v8 ignore next -- falha inesperada do banco: vai pro handler global (500) */
			if (!(err instanceof HttpError)) throw err;
			return c.json({ error: err.message }, err.status);
		}
	});

	routes.post("/finance/transactions/:id/void", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const id = c.req.param("id");
		if (!uuidSchema.safeParse(id).success) {
			return c.json({ error: "Registro inválido" }, 400);
		}
		const [current] = await db
			.select()
			.from(transactions)
			.where(
				and(
					eq(transactions.id, id),
					eq(transactions.businessId, user.businessId),
				),
			)
			.limit(1);
		if (!current) return c.json({ error: "Lançamento não encontrado" }, 404);
		if (current.voidedAt) {
			return c.json({ error: "Este lançamento já foi estornado" }, 409);
		}
		const [voided] = await db
			.update(transactions)
			.set({ voidedAt: new Date() })
			.where(and(eq(transactions.id, id), sql`voided_at IS NULL`))
			.returning();
		/* v8 ignore next 3 -- corrida: outro estorno entre o SELECT e o UPDATE */
		if (!voided) {
			return c.json({ error: "Este lançamento já foi estornado" }, 409);
		}
		let appointment = null;
		if (voided.appointmentId) {
			const [appt] = await db
				.select({ priceCents: appointments.priceCents })
				.from(appointments)
				.where(eq(appointments.id, voided.appointmentId))
				.limit(1);
			/* v8 ignore next -- FK garante o agendamento */
			appointment = await financeOf(
				db,
				voided.appointmentId,
				appt?.priceCents ?? 0,
			);
		}
		return c.json({ payment: paymentJson(voided), appointment });
	});

	routes.get("/finance/receivables", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const parsed = receivablesQuerySchema.safeParse(c.req.query());
		if (!parsed.success) {
			return c.json({ error: firstIssue(parsed.error) }, 400);
		}
		const q = parsed.data;
		const now = new Date();
		const to = q.to
			? new Date(q.to)
			: new Date(now.getTime() + RECEIVABLES_AHEAD_MS);

		const paid = paidCentsSql;
		const rows = await db
			.select({
				id: appointments.id,
				starts_at: appointments.startsAt,
				status: appointments.status,
				client_id: appointments.clientId,
				client_name: clients.name,
				service_name: services.name,
				price_cents: appointments.priceCents,
				paid_cents: paid,
			})
			.from(appointments)
			.innerJoin(clients, eq(appointments.clientId, clients.id))
			.innerJoin(services, eq(appointments.serviceId, services.id))
			.where(
				and(
					eq(appointments.businessId, user.businessId),
					// cancelado e falta ficam fora (D2); bloqueio não tem valor
					sql`${appointments.status} IN ('pending', 'confirmed', 'done')`,
					sql`${appointments.source} <> 'block'`,
					sql`${appointments.priceCents} > ${paid}`,
					q.from ? gte(appointments.startsAt, new Date(q.from)) : undefined,
					lte(appointments.startsAt, to),
					q.client_id ? eq(appointments.clientId, q.client_id) : undefined,
				),
			)
			.orderBy(asc(appointments.startsAt), desc(appointments.id));

		let overdue = 0;
		let upcoming = 0;
		const items = rows.map((r) => {
			const fin = paymentStatus(r.price_cents, r.paid_cents);
			if (r.starts_at <= now) overdue += fin.balance_cents;
			else upcoming += fin.balance_cents;
			return { ...r, ...fin };
		});
		return c.json({
			items,
			total_open_cents: overdue + upcoming,
			overdue_cents: overdue,
			upcoming_cents: upcoming,
		});
	});

	return routes;
}
