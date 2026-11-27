/**
 * Webhook das subcontas Asaas (módulo de finanças F5,
 * .planning/financas/SPEC-F5-CHECKOUT.md). Cada subconta é criada com um
 * webhook apontando para /webhooks/asaas/subaccounts/<business_id>.
 *
 * - Auth: header asaas-access-token vs ASAAS_SUBACCOUNT_WEBHOOK_TOKEN
 *   (constant-time). Recurso desligado → 401 (fail-closed).
 * - Nunca 4xx em evento tratável (o Asaas repetiria): desconhecido → 200.
 * - Entrega "at least once": pagamento vira no máximo 1 lançamento
 *   (transactions.asaas_payment_id único).
 */

import { timingSafeEqual } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/connection.js";
import {
	appointments,
	businesses,
	charges,
	transactions,
} from "../db/schema.js";
import { loadSubaccountConfig } from "../services/asaas-subaccounts.js";
import type { AppEnv } from "../types.js";
import { mapAccountStatus } from "./finance-online.js";
import { openCashSessionId, uuidSchema } from "./finance-shared.js";

function tokenMatches(expected: string, received: string): boolean {
	const a = Buffer.from(expected);
	const b = Buffer.from(received);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** billingType do Asaas → forma de pagamento do livro-caixa. */
export function methodOf(billingType: string | undefined): string {
	if (billingType === "PIX") return "pix";
	if (billingType === "CREDIT_CARD") return "credit";
	if (billingType === "DEBIT_CARD") return "debit";
	return "other"; // boleto e demais
}

type Body = {
	event?: string;
	payment?: {
		id?: string;
		billingType?: string;
		installmentCount?: number;
		paymentDate?: string;
		clientPaymentDate?: string;
	};
};

export function asaasSubaccountWebhookRoutes(databaseUrl: string) {
	const db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.post("/webhooks/asaas/subaccounts/:businessId", async (c) => {
		const cfg = loadSubaccountConfig(process.env);
		const received = c.req.header("asaas-access-token") ?? "";
		if (!cfg || !tokenMatches(cfg.webhookToken, received)) {
			return c.json({ error: "não autorizado" }, 401);
		}
		const businessId = c.req.param("businessId");
		if (!uuidSchema.safeParse(businessId).success) {
			return c.json({ ok: true, ignored: true });
		}
		const body = (await c.req.json().catch(() => null)) as Body | null;
		const event = typeof body?.event === "string" ? body.event : "";
		const ok = (extra: Record<string, unknown> = {}) =>
			c.json({ ok: true, ...extra });

		if (event.startsWith("ACCOUNT_STATUS_GENERAL_APPROVAL_")) {
			const status = mapAccountStatus(
				event.replace("ACCOUNT_STATUS_GENERAL_APPROVAL_", ""),
			);
			const updated = await db
				.update(businesses)
				.set({ asaasSubStatus: status, asaasSubUpdatedAt: new Date() })
				.where(
					and(
						eq(businesses.id, businessId),
						isNotNull(businesses.asaasSubAccountId),
					),
				)
				.returning({ id: businesses.id });
			return ok({ status, updated: updated.length > 0 });
		}

		const paymentId = body?.payment?.id;
		if (!event.startsWith("PAYMENT_") || typeof paymentId !== "string") {
			console.log(`[webhook-subconta] evento ignorado: ${event || "(vazio)"}`);
			return ok({ ignored: true });
		}

		const [ch] = await db
			.select()
			.from(charges)
			.where(eq(charges.asaasPaymentId, paymentId))
			.limit(1);
		if (!ch || ch.businessId !== businessId) {
			// cobrança que não é nossa (outro ambiente/manual no painel)
			return ok({ ignored: true });
		}

		if (event === "PAYMENT_CONFIRMED" || event === "PAYMENT_RECEIVED") {
			if (ch.status === "paid") return ok({ duplicate: true });
			await db.transaction(async (tx) => {
				const [a] = await tx
					.select({
						startsAt: appointments.startsAt,
						status: appointments.status,
						clientId: appointments.clientId,
					})
					.from(appointments)
					.where(eq(appointments.id, ch.appointmentId))
					.for("update");
				/* v8 ignore next -- FK garante o agendamento */
				if (!a) throw new Error("agendamento desapareceu");
				const paidAt = body?.payment?.clientPaymentDate
					? new Date(body.payment.clientPaymentDate)
					: new Date();
				const kind =
					paidAt < a.startsAt &&
					(a.status === "pending" || a.status === "confirmed")
						? "deposit"
						: "payment";
				const method = methodOf(body?.payment?.billingType);
				const [t] = await tx
					.insert(transactions)
					.values({
						businessId,
						type: "income",
						kind,
						amountCents: ch.amountCents,
						category: "atendimento",
						appointmentId: ch.appointmentId,
						clientId: a.clientId,
						paymentMethod: method,
						installments:
							method === "credit"
								? Math.min(
										Math.max(body?.payment?.installmentCount ?? 1, 1),
										12,
									)
								: 1,
						occurredAt: paidAt,
						notes: "Pago pelo link (Asaas)",
						asaasPaymentId: paymentId,
						cashSessionId: await openCashSessionId(tx, businessId),
					})
					.onConflictDoNothing()
					.returning({ id: transactions.id });
				await tx
					.update(charges)
					.set({
						status: "paid",
						updatedAt: new Date(),
						...(t ? { transactionId: t.id } : {}),
					})
					.where(eq(charges.id, ch.id));
			});
			return ok({ status: "paid" });
		}

		const next =
			event === "PAYMENT_OVERDUE"
				? "overdue"
				: event === "PAYMENT_DELETED"
					? "canceled"
					: event === "PAYMENT_REFUNDED"
						? "refunded"
						: null;
		if (!next) return ok({ ignored: true });
		if (next === "refunded" && ch.transactionId) {
			await db
				.update(transactions)
				.set({ voidedAt: new Date() })
				.where(eq(transactions.id, ch.transactionId));
		}
		// atraso/cancelamento não desfazem um pagamento já confirmado
		if (ch.status !== "paid" || next === "refunded") {
			await db
				.update(charges)
				.set({ status: next, updatedAt: new Date() })
				.where(eq(charges.id, ch.id));
		}
		return ok({ status: next });
	});

	return routes;
}
