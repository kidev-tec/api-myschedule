/**
 * Módulo de finanças — Fase 2: caixa diário
 * (.planning/financas/SPEC.md, TASK-F2-03; RF-F05).
 *
 * - GET  /finance/cash/current   — caixa aberto (ou null) com o resumo
 * - POST /finance/cash/open      — abre com saldo inicial (troco)
 * - POST /finance/cash/movements — suprimento (in) / sangria (out)
 * - POST /finance/cash/close     — fecha com o valor contado
 * - GET  /finance/cash           — histórico de caixas fechados
 *
 * O caixa confere SÓ dinheiro em espécie:
 *   esperado = inicial + entradas em dinheiro − saídas em dinheiro
 * (lançamentos não anulados ligados ao caixa). Pix/cartão aparecem em
 * by_method só como informação. Suprimento/sangria não são receita/despesa.
 */

import { and, asc, desc, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type Db, getDb } from "../db/connection.js";
import { cashSessions, transactions } from "../db/schema.js";
import { formatBRL, MAX_CENTS } from "../domain/payment-status.js";
import type { AppEnv } from "../types.js";
import {
	amountCents,
	cleanNotes,
	firstIssue,
	HttpError,
	isoDate,
	notes,
	requireUser,
} from "./finance-shared.js";

const cents0 = z
	.int("Valor inválido")
	.min(0, "Valor inválido")
	.max(MAX_CENTS, "Valor inválido");

export const cashOpenSchema = z.object({
	opening_cents: cents0,
	notes: notes.optional(),
});
export const cashCloseSchema = z.object({
	counted_cents: cents0,
	notes: notes.optional(),
});
export const cashMovementSchema = z.object({
	direction: z.enum(["in", "out"], "Tipo de movimento inválido"),
	amount_cents: amountCents,
	notes: notes.optional(),
});
export const cashHistoryQuerySchema = z.object({
	from: isoDate.optional(),
	to: isoDate.optional(),
});

/** Sem período: os últimos caixas fechados. */
const HISTORY_LIMIT = 30;

type Session = typeof cashSessions.$inferSelect;
type Reader = Pick<Db, "select">;

/** Resumo do caixa calculado do livro-caixa. */
async function summary(db: Reader, s: Session) {
	const rows = await db
		.select()
		.from(transactions)
		.where(eq(transactions.cashSessionId, s.id))
		.orderBy(asc(transactions.occurredAt), asc(transactions.createdAt));
	let cashIn = 0;
	let cashOut = 0;
	const byMethod: Record<string, number> = {};
	for (const t of rows) {
		if (t.voidedAt) continue;
		if (t.paymentMethod === "cash") {
			if (t.type === "income") cashIn += t.amountCents;
			else cashOut += t.amountCents;
		}
		// recebidos por forma (suprimento não é recebimento)
		if (t.type === "income" && t.kind !== "cash_in" && t.paymentMethod) {
			byMethod[t.paymentMethod] =
				(byMethod[t.paymentMethod] ?? 0) + t.amountCents;
		}
	}
	const expected = s.openingCents + cashIn - cashOut;
	return {
		id: s.id,
		opened_at: s.openedAt,
		opening_cents: s.openingCents,
		cash_in_cents: cashIn,
		cash_out_cents: cashOut,
		expected_cents: s.expectedCents ?? expected,
		by_method: byMethod,
		movements: rows.map((t) => ({
			id: t.id,
			kind: t.kind,
			type: t.type,
			amount_cents: t.amountCents,
			payment_method: t.paymentMethod,
			category: t.category,
			notes: t.notes,
			occurred_at: t.occurredAt,
			voided_at: t.voidedAt,
		})),
		closed_at: s.closedAt,
		counted_cents: s.countedCents,
		difference_cents:
			s.countedCents === null || s.expectedCents === null
				? null
				: s.countedCents - s.expectedCents,
		notes: s.notes,
	};
}

/** Caixa aberto travado para escrita (serializa sangria/fechamento). */
async function lockOpen(tx: Reader & Pick<Db, "select">, businessId: string) {
	const [s] = await tx
		.select()
		.from(cashSessions)
		.where(
			and(
				eq(cashSessions.businessId, businessId),
				isNull(cashSessions.closedAt),
			),
		)
		.for("update");
	if (!s) throw new HttpError(409, "Abra o caixa primeiro");
	return s;
}

function pgErrorCode(err: unknown): string | undefined {
	const e = err as { code?: string; cause?: { code?: string } };
	/* v8 ignore next -- formato do erro varia por driver */
	return e.code ?? e.cause?.code;
}

async function readJson(c: { req: { json: () => Promise<unknown> } }) {
	return c.req.json().catch(() => undefined);
}

export function financeCashRoutes(databaseUrl: string) {
	const db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.get("/finance/cash/current", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const [s] = await db
			.select()
			.from(cashSessions)
			.where(
				and(
					eq(cashSessions.businessId, user.businessId),
					isNull(cashSessions.closedAt),
				),
			)
			.limit(1);
		return c.json({ session: s ? await summary(db, s) : null });
	});

	routes.post("/finance/cash/open", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const raw = await readJson(c);
		if (raw === undefined) return c.json({ error: "Dados inválidos" }, 400);
		const parsed = cashOpenSchema.safeParse(raw);
		if (!parsed.success) {
			return c.json({ error: firstIssue(parsed.error) }, 400);
		}
		try {
			const [s] = await db
				.insert(cashSessions)
				.values({
					businessId: user.businessId,
					openedBy: user.id,
					openingCents: parsed.data.opening_cents,
					notes: cleanNotes(parsed.data.notes),
				})
				.returning();
			/* v8 ignore next -- INSERT..RETURNING nunca é vazio */
			if (!s) throw new Error("falha ao abrir o caixa");
			return c.json({ session: await summary(db, s) }, 201);
		} catch (err) {
			// índice único: já existe caixa aberto (inclusive corrida)
			/* v8 ignore next -- outra falha do banco: handler global (500) */
			if (pgErrorCode(err) !== "23505") throw err;
			return c.json({ error: "O caixa já está aberto" }, 409);
		}
	});

	routes.post("/finance/cash/movements", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const raw = await readJson(c);
		if (raw === undefined) return c.json({ error: "Dados inválidos" }, 400);
		const parsed = cashMovementSchema.safeParse(raw);
		if (!parsed.success) {
			return c.json({ error: firstIssue(parsed.error) }, 400);
		}
		const m = parsed.data;
		try {
			const session = await db.transaction(async (tx) => {
				const s = await lockOpen(tx, user.businessId);
				if (m.direction === "out") {
					const { expected_cents } = await summary(tx, s);
					if (m.amount_cents > expected_cents) {
						throw new HttpError(
							422,
							`Não há dinheiro suficiente no caixa (esperado ${formatBRL(expected_cents)})`,
						);
					}
				}
				await tx.insert(transactions).values({
					businessId: user.businessId,
					type: m.direction === "in" ? "income" : "expense",
					kind: m.direction === "in" ? "cash_in" : "cash_out",
					category: m.direction === "in" ? "suprimento" : "sangria",
					amountCents: m.amount_cents,
					paymentMethod: "cash",
					notes: cleanNotes(m.notes),
					createdByUserId: user.id,
					cashSessionId: s.id,
				});
				return summary(tx, s);
			});
			return c.json({ session }, 201);
		} catch (err) {
			/* v8 ignore next -- falha inesperada do banco: handler global (500) */
			if (!(err instanceof HttpError)) throw err;
			return c.json({ error: err.message }, err.status);
		}
	});

	routes.post("/finance/cash/close", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const raw = await readJson(c);
		if (raw === undefined) return c.json({ error: "Dados inválidos" }, 400);
		const parsed = cashCloseSchema.safeParse(raw);
		if (!parsed.success) {
			return c.json({ error: firstIssue(parsed.error) }, 400);
		}
		try {
			const session = await db.transaction(async (tx) => {
				const s = await lockOpen(tx, user.businessId);
				const { expected_cents } = await summary(tx, s);
				const [closed] = await tx
					.update(cashSessions)
					.set({
						closedAt: new Date(),
						closedBy: user.id,
						countedCents: parsed.data.counted_cents,
						expectedCents: expected_cents,
						notes: cleanNotes(parsed.data.notes) ?? s.notes,
					})
					.where(eq(cashSessions.id, s.id))
					.returning();
				/* v8 ignore next -- UPDATE..RETURNING na linha travada */
				if (!closed) throw new Error("caixa desapareceu");
				return summary(tx, closed);
			});
			return c.json({ session });
		} catch (err) {
			/* v8 ignore next -- falha inesperada do banco: handler global (500) */
			if (!(err instanceof HttpError)) throw err;
			return c.json({ error: err.message }, err.status);
		}
	});

	routes.get("/finance/cash", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const parsed = cashHistoryQuerySchema.safeParse(c.req.query());
		if (!parsed.success) {
			return c.json({ error: firstIssue(parsed.error) }, 400);
		}
		const q = parsed.data;
		const rows = await db
			.select()
			.from(cashSessions)
			.where(
				and(
					eq(cashSessions.businessId, user.businessId),
					isNotNull(cashSessions.closedAt),
					q.from ? gte(cashSessions.openedAt, new Date(q.from)) : undefined,
					q.to ? lte(cashSessions.openedAt, new Date(q.to)) : undefined,
				),
			)
			.orderBy(desc(cashSessions.openedAt))
			.limit(q.from || q.to ? 366 : HISTORY_LIMIT);
		const sessions = [];
		for (const s of rows) {
			const { movements: _m, ...rest } = await summary(db, s);
			sessions.push(rest);
		}
		return c.json({ sessions });
	});

	return routes;
}
