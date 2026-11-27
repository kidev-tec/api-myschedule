/**
 * Fragmentos SQL do módulo de finanças (SPEC .planning/financas).
 * Situação da cobrança é sempre derivada do livro-caixa (transactions).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./connection.js";
import { appointments, services, transactions } from "./schema.js";

/**
 * Preço atual do serviço, para gravar como snapshot no agendamento.
 * Serviço de outro negócio ou inexistente → 0 (a FK do insert recusa o
 * inexistente com 23503, mantendo a mensagem de sempre).
 */
export function servicePriceSql(serviceId: string, businessId: string) {
	return sql<number>`COALESCE((SELECT ${services.priceCents} FROM ${services}
    WHERE ${services.id} = ${serviceId} AND ${services.businessId} = ${businessId}), 0)`;
}

/** Recebido (não anulado) do agendamento da linha — para SELECT em appointments. */
export const paidCentsSql = sql<number>`(SELECT COALESCE(SUM(t.amount_cents), 0)::int
  FROM transactions t
  WHERE t.appointment_id = ${appointments.id}
    AND t.type = 'income' AND t.voided_at IS NULL)`;

type Tx = Pick<Db, "select">;

/** Recebido (não anulado) de um agendamento. */
export async function paidCentsOf(db: Tx, appointmentId: string) {
	const [row] = await db
		.select({
			paid: sql<number>`COALESCE(SUM(${transactions.amountCents}), 0)::int`,
		})
		.from(transactions)
		.where(
			and(
				eq(transactions.appointmentId, appointmentId),
				eq(transactions.type, "income"),
				isNull(transactions.voidedAt),
			),
		);
	/* v8 ignore next -- agregado sem GROUP BY sempre devolve 1 linha */
	return row?.paid ?? 0;
}
