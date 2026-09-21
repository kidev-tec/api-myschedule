/**
 * Billing (RF-14 — SPEC .planning/billing-asaas/SPEC.md, Fase A).
 *
 * POST /billing/checkout (authed, writable):
 * - 503 se o ambiente não tem ASAAS_API_KEY (fail-closed)
 * - 409 se o business já tem assinatura ativa
 * - cria/recupera customer + cria subscription MONTHLY no Asaas,
 *   persiste os ids e devolve { invoiceUrl } pro app abrir no browser.
 *
 * O app nunca fala com o Asaas: só recebe a URL de checkout.
 * O status da assinatura muda EXCLUSIVAMENTE pelo webhook (Fase B).
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import { businesses, users } from "../db/schema.js";
import {
	createCustomer,
	createSubscription,
	loadAsaasConfig,
} from "../services/asaas.js";
import type { AppEnv } from "../types.js";

export function billingRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.post("/billing/checkout", async (c) => {
		const config = loadAsaasConfig(process.env);
		if (config === null || config.planValueCents <= 0) {
			return c.json({ error: "Cobrança indisponível no momento" }, 503);
		}

		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, c.get("authUser").uid))
				.limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall/auth retorna antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);

		const biz = (
			await db
				.select()
				.from(businesses)
				.where(eq(businesses.id, me.businessId))
				.limit(1)
		)[0];
		/* v8 ignore next -- inatingível: FK NOT NULL user→business */
		if (!biz) return c.json({ error: "negócio não encontrado" }, 404);

		if (biz.asaasSubscriptionId) {
			return c.json({ error: "Você já tem uma assinatura ativa" }, 409);
		}

		try {
			const customer = biz.asaasCustomerId
				? { id: biz.asaasCustomerId }
				: await createCustomer(config, {
						name: biz.name,
						email: me.email,
						externalReference: biz.id,
					});

			// próximo vencimento = amanhã (Asaas exige data futura, formato YYYY-MM-DD)
			const nextDue = new Date(Date.now() + 24 * 60 * 60 * 1000)
				.toISOString()
				.slice(0, 10);
			const subscription = await createSubscription(config, {
				customerId: customer.id,
				nextDueDate: nextDue,
			});

			await db
				.update(businesses)
				.set({
					asaasCustomerId: customer.id,
					asaasSubscriptionId: subscription.id,
				})
				.where(eq(businesses.id, biz.id));

			return c.json({ invoiceUrl: subscription.invoiceUrl ?? null }, 201);
		} catch (e) {
			console.error("[billing] falha no checkout do Asaas:", e);
			return c.json({ error: "Cobrança indisponível no momento" }, 503);
		}
	});

	return routes;
}
