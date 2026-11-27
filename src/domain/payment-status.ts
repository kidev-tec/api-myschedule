/**
 * Situação da cobrança de um agendamento (módulo de finanças, RF-F02/F03).
 * Sempre DERIVADA do livro-caixa — nunca gravada (SPEC §2.4):
 *   recebido = soma dos recebimentos não anulados
 *   saldo    = valor − recebido
 */

export type PaymentStatus = "none" | "open" | "partial" | "paid";

export type AppointmentFinance = {
	price_cents: number;
	paid_cents: number;
	balance_cents: number;
	payment_status: PaymentStatus;
};

export function paymentStatus(
	priceCents: number,
	paidCents: number,
): AppointmentFinance {
	const balance = Math.max(priceCents - paidCents, 0);
	let status: PaymentStatus;
	if (priceCents === 0) status = "none";
	else if (paidCents >= priceCents) status = "paid";
	else if (paidCents > 0) status = "partial";
	else status = "open";
	return {
		price_cents: priceCents,
		paid_cents: paidCents,
		balance_cents: balance,
		payment_status: status,
	};
}

/** Maior valor aceito num agendamento/recebimento: R$ 1.000.000,00. */
export const MAX_CENTS = 100_000_000;

/** Valor em centavos válido: inteiro entre 0 e MAX_CENTS. */
export function isValidCents(v: unknown): v is number {
	return (
		Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_CENTS
	);
}

const brl = new Intl.NumberFormat("pt-BR", {
	style: "currency",
	currency: "BRL",
});

/** "R$ 1.234,56" (espaço normal, para mensagens de erro legíveis). */
export function formatBRL(cents: number): string {
	return brl.format(cents / 100).replace(/\s/g, " ");
}
