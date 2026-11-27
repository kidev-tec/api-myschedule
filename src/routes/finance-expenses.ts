/**
 * Módulo de finanças — Fase 2: despesas
 * (.planning/financas/SPEC.md, TASK-F2-02; RF-F06).
 *
 * - POST /finance/expenses          — paga (padrão) ou a pagar (vencimento)
 * - POST /finance/expenses/:id/pay  — paga uma despesa a pagar
 * - GET  /finance/expenses          — lista + totais (pagas, a pagar, vencidas)
 * Estorno: POST /finance/transactions/:id/void (finance.ts).
 *
 * Despesa a pagar guarda o vencimento em due_at e também em occurred_at
 * (data de referência para ordenar/filtrar); ao pagar, occurred_at vira a
 * data do pagamento.
 */

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import { transactions } from "../db/schema.js";
import type { AppEnv } from "../types.js";
import {
	amountCents,
	cleanNotes,
	firstIssue,
	isoDate,
	notes,
	openCashSessionId,
	paymentMethod,
	requireUser,
	uuidSchema,
} from "./finance-shared.js";

/** Categorias fixas (decisão D5); "outros" exige descrição. */
export const EXPENSE_CATEGORIES = [
	"materiais",
	"aluguel",
	"taxas",
	"energia_agua",
	"marketing",
	"outros",
] as const;

const category = z.enum(EXPENSE_CATEGORIES, "Categoria inválida");

export const expenseCreateSchema = z
	.object({
		amount_cents: amountCents,
		category,
		paid: z.boolean("Informe se já foi paga").optional(),
		date: isoDate.optional(),
		payment_method: paymentMethod.optional(),
		notes: notes.optional(),
	})
	.superRefine((b, ctx) => {
		const paid = b.paid ?? true;
		if (paid && !b.payment_method) {
			ctx.addIssue({ code: "custom", message: "Informe a forma de pagamento" });
		} else if (!paid && !b.date) {
			ctx.addIssue({ code: "custom", message: "Informe o vencimento" });
		} else if (b.category === "outros" && !cleanNotes(b.notes)) {
			ctx.addIssue({ code: "custom", message: "Descreva a despesa" });
		}
	});

export const expensePaySchema = z.object({
	payment_method: paymentMethod,
	date: isoDate.optional(),
});

export const expensesQuerySchema = z.object({
	from: isoDate.optional(),
	to: isoDate.optional(),
	category: category.optional(),
	status: z.enum(["paid", "pending"], "Situação inválida").optional(),
});

type Tx = typeof transactions.$inferSelect;

function expenseJson(t: Tx, now = new Date()) {
	return {
		id: t.id,
		amount_cents: t.amountCents,
		category: t.category,
		payment_method: t.paymentMethod,
		paid: t.paid,
		due_at: t.dueAt,
		occurred_at: t.occurredAt,
		notes: t.notes,
		voided_at: t.voidedAt,
		overdue: !t.paid && !t.voidedAt && t.dueAt !== null && t.dueAt < now,
		created_at: t.createdAt,
	};
}

export function financeExpenseRoutes(databaseUrl: string) {
	const db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.post("/finance/expenses", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const raw = await c.req.json().catch(() => undefined);
		if (raw === undefined) return c.json({ error: "Dados inválidos" }, 400);
		const parsed = expenseCreateSchema.safeParse(raw);
		if (!parsed.success) {
			return c.json({ error: firstIssue(parsed.error) }, 400);
		}
		const b = parsed.data;
		const paid = b.paid ?? true;
		const date = b.date ? new Date(b.date) : new Date();
		const [created] = await db
			.insert(transactions)
			.values({
				businessId: user.businessId,
				type: "expense",
				kind: "expense",
				amountCents: b.amount_cents,
				category: b.category,
				paymentMethod: b.payment_method ?? null,
				paid,
				dueAt: paid ? null : date,
				occurredAt: date,
				notes: cleanNotes(b.notes),
				createdByUserId: user.id,
				// a pagar não movimenta dinheiro: só a paga entra no caixa
				cashSessionId: paid
					? await openCashSessionId(db, user.businessId)
					: null,
			})
			.returning();
		/* v8 ignore next -- INSERT..RETURNING nunca é vazio */
		if (!created) throw new Error("falha ao registrar despesa");
		return c.json({ expense: expenseJson(created) }, 201);
	});

	routes.post("/finance/expenses/:id/pay", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const id = c.req.param("id");
		if (!uuidSchema.safeParse(id).success) {
			return c.json({ error: "Registro inválido" }, 400);
		}
		const raw = await c.req.json().catch(() => undefined);
		if (raw === undefined) return c.json({ error: "Dados inválidos" }, 400);
		const parsed = expensePaySchema.safeParse(raw);
		if (!parsed.success) {
			return c.json({ error: firstIssue(parsed.error) }, 400);
		}
		const [current] = await db
			.select()
			.from(transactions)
			.where(
				and(
					eq(transactions.id, id),
					eq(transactions.businessId, user.businessId),
					eq(transactions.kind, "expense"),
				),
			)
			.limit(1);
		if (!current) return c.json({ error: "Despesa não encontrada" }, 404);
		if (current.voidedAt) {
			return c.json({ error: "Esta despesa foi estornada" }, 409);
		}
		if (current.paid) {
			return c.json({ error: "Esta despesa já está paga" }, 409);
		}
		const [updated] = await db
			.update(transactions)
			.set({
				paid: true,
				paymentMethod: parsed.data.payment_method,
				occurredAt: parsed.data.date ? new Date(parsed.data.date) : new Date(),
				cashSessionId: await openCashSessionId(db, user.businessId),
			})
			.where(and(eq(transactions.id, id), eq(transactions.paid, false)))
			.returning();
		/* v8 ignore next 3 -- corrida: outro "pagar" entre o SELECT e o UPDATE */
		if (!updated) {
			return c.json({ error: "Esta despesa já está paga" }, 409);
		}
		return c.json({ expense: expenseJson(updated) });
	});

	routes.get("/finance/expenses", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const parsed = expensesQuerySchema.safeParse(c.req.query());
		if (!parsed.success) {
			return c.json({ error: firstIssue(parsed.error) }, 400);
		}
		const q = parsed.data;
		const rows = await db
			.select()
			.from(transactions)
			.where(
				and(
					eq(transactions.businessId, user.businessId),
					eq(transactions.kind, "expense"),
					q.from ? gte(transactions.occurredAt, new Date(q.from)) : undefined,
					q.to ? lte(transactions.occurredAt, new Date(q.to)) : undefined,
					q.category ? eq(transactions.category, q.category) : undefined,
					q.status ? eq(transactions.paid, q.status === "paid") : undefined,
				),
			)
			.orderBy(desc(transactions.occurredAt), desc(sql`${transactions.id}`));

		const now = new Date();
		let paidCents = 0;
		let pendingCents = 0;
		let overdueCents = 0;
		const items = rows.map((t) => {
			const e = expenseJson(t, now);
			if (!t.voidedAt) {
				if (t.paid) paidCents += t.amountCents;
				else pendingCents += t.amountCents;
				if (e.overdue) overdueCents += t.amountCents;
			}
			return e;
		});
		return c.json({
			items,
			paid_cents: paidCents,
			pending_cents: pendingCents,
			overdue_cents: overdueCents,
		});
	});

	return routes;
}
