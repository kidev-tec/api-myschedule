/**
 * Peças comuns das rotas do módulo de finanças (finance*.ts).
 */
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/connection.js";
import { cashSessions, users } from "../db/schema.js";
import { MAX_CENTS } from "../domain/payment-status.js";

export const PAYMENT_METHODS = [
	"pix",
	"cash",
	"debit",
	"credit",
	"payment_link",
	"other",
] as const;

export const NOTES_MAX = 500;

export const isoDate = z
	.string()
	.refine((v) => !Number.isNaN(new Date(v).getTime()), "Data inválida");

export const amountCents = z
	.int("Valor inválido")
	.min(1, "Valor inválido")
	.max(MAX_CENTS, "Valor inválido");

export const paymentMethod = z.enum(
	PAYMENT_METHODS,
	"Forma de pagamento inválida",
);

export const notes = z
	.string("Observações devem ser texto")
	.max(NOTES_MAX, `Observações: no máximo ${NOTES_MAX} caracteres`);

export const uuidSchema = z.uuid();

/** 1ª mensagem do Zod (já em PT-BR) — o usuário leigo lê o `error`. */
export function firstIssue(err: z.ZodError): string {
	/* v8 ignore next -- ZodError sempre tem ao menos 1 issue */
	return err.issues[0]?.message ?? "Dados inválidos";
}

/** Texto aparado; vazio vira null. */
export function cleanNotes(v: string | undefined): string | null {
	return v?.trim() || null;
}

export async function requireUser(db: Db, firebaseUid: string) {
	const [row] = await db
		.select({ id: users.id, businessId: users.businessId })
		.from(users)
		.where(eq(users.firebaseUid, firebaseUid))
		.limit(1);
	/* v8 ignore next -- usuário sem sync: auth/paywall respondem antes */
	return row ?? null;
}

type Reader = Pick<Db, "select">;

/** Caixa aberto do negócio (null = nenhum). Lançamentos novos se ligam a ele. */
export async function openCashSessionId(
	db: Reader,
	businessId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ id: cashSessions.id })
		.from(cashSessions)
		.where(
			and(
				eq(cashSessions.businessId, businessId),
				isNull(cashSessions.closedAt),
			),
		)
		.limit(1);
	return row?.id ?? null;
}

/** Erros de regra (inclusive dentro de transação) → resposta HTTP. */
export class HttpError extends Error {
	constructor(
		readonly status: 404 | 409 | 422,
		message: string,
	) {
		super(message);
	}
}
