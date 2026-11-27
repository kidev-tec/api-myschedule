/**
 * Webhook do Asaas (RF-14, Fase B — SPEC billing-asaas).
 *
 * POST /webhooks/asaas — PÚBLICO (o Asaas não tem nosso Firebase).
 * Auth: header asaas-access-token vs ASAAS_WEBHOOK_TOKEN (constant-time).
 * O webhook é a ÚNICA fonte de verdade do subscription_status.
 * Nunca responder 4xx pro Asaas em evento tratável (evita retry loop):
 * evento desconhecido/customer desconhecido → 200 com log.
 */

import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import { businesses } from "../db/schema.js";
import type { AppEnv } from "../types.js";

/**
 * Evento Asaas → subscription_status. null = ignorar.
 *
 * O Asaas envia o campo `event` com UNDERSCORE (ex. "PAYMENT_RECEIVED" —
 * docs.asaas.com/docs/webhook-para-cobrancas e /eventos-para-assinaturas).
 * O formato com ponto ("PAYMENT.CONFIRMED") nunca existiu na API; segue
 * aceito só por compatibilidade com o que já estava no código.
 */
export function eventToStatus(event: string): string | null {
	switch (event.replaceAll(".", "_")) {
		case "PAYMENT_CONFIRMED":
		case "PAYMENT_RECEIVED":
			return "active";
		case "PAYMENT_OVERDUE":
			return "past_due";
		case "PAYMENT_REFUNDED":
		case "SUBSCRIPTION_INACTIVATED":
		case "SUBSCRIPTION_DELETED":
		case "SUBSCRIPTION_CANCELED": // legado (com ponto) — não é evento oficial
			return "canceled";
		default:
			return null;
	}
}

function tokenMatches(expected: string | undefined, received: string): boolean {
	if (!expected) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(received);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export function asaasWebhookRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.post("/webhooks/asaas", async (c) => {
		const received =
			c.req.header("asaas-access-token") ??
			c.req.header("Asaas-access-token") ??
			"";
		if (!tokenMatches(process.env.ASAAS_WEBHOOK_TOKEN, received)) {
			return c.json({ error: "não autorizado" }, 401);
		}

		const body = (await c.req.json().catch(() => null)) as {
			event?: string;
			payment?: { customer?: string };
			subscription?: { customer?: string };
		} | null;

		const event = typeof body?.event === "string" ? body.event : "";
		const status = eventToStatus(event);
		if (status === null) {
			console.log(`[webhook-asaas] evento ignorado: ${event || "(vazio)"}`);
			return c.json({ ok: true, ignored: true });
		}

		const customerId = body?.payment?.customer ?? body?.subscription?.customer;
		if (typeof customerId !== "string" || customerId === "") {
			console.log(`[webhook-asaas] ${event} sem customer — ignorado`);
			return c.json({ ok: true, ignored: true });
		}

		const biz = (
			await db
				.select({ id: businesses.id, status: businesses.subscriptionStatus })
				.from(businesses)
				.where(eq(businesses.asaasCustomerId, customerId))
				.limit(1)
		)[0];
		if (!biz) {
			// customer que não é nosso (ex: outro ambiente) — nunca 4xx
			console.log(
				`[webhook-asaas] customer ${customerId} desconhecido — ignorado`,
			);
			return c.json({ ok: true, ignored: true });
		}

		// Idempotência: estado já é o esperado → sem UPDATE (evento repetido)
		if (biz.status !== status) {
			await db
				.update(businesses)
				.set({ subscriptionStatus: status })
				.where(eq(businesses.id, biz.id));
			console.log(`[webhook-asaas] ${biz.id}: ${biz.status} → ${status}`);
		}
		return c.json({ ok: true, status });
	});

	return routes;
}
