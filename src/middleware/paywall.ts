/**
 * Paywall pós-trial (RF-14).
 *
 * Regra: trial vencido bloqueia ESCRITA (criar/editar agendamentos, serviços,
 * clientes); LEITURA continua liberada para o profissional ver os dados que já
 * existem — o bloqueio tem que incomodar sem destruir o histórico.
 *
 * Estados de subscription_status:
 * - 'trial'    → ativo enquanto trial_ends_at > now
 * - 'active'   → pago, tudo liberado
 * - 'canceled' / 'past_due' / expirado → somente leitura
 */

import { eq } from "drizzle-orm";
import type { Context, Next } from "hono";

// biome_ignore: middleware Hono usa Response | void como assinatura padrão
import { type Db, getDb } from "../db/connection.js";
import { businesses, users } from "../db/schema.js";
import type { AppEnv } from "../types.js";

export type BusinessGate = {
	businessId: string;
	subscriptionStatus: string;
	trialEndsAt: Date | null;
};

/** Busca o business do usuário logado e indica se a conta pode escrever. */
export async function loadBusinessGate(
	db: Db,
	firebaseUid: string,
): Promise<BusinessGate | null> {
	const me = (
		await db
			.select()
			.from(users)
			.where(eq(users.firebaseUid, firebaseUid))
			.limit(1)
	)[0];
	if (!me) return null;
	const biz = (
		await db
			.select()
			.from(businesses)
			.where(eq(businesses.id, me.businessId))
			.limit(1)
	)[0];
	/* v8 ignore next 3 -- inatingível no fluxo real: user sempre tem business
	   (FK NOT NULL + sync atômico); coberto defensivamente */
	if (!biz) return null;
	return {
		businessId: biz.id,
		/* v8 ignore next -- coluna NOT NULL; guard defensivo p/ legado */
		subscriptionStatus: biz.subscriptionStatus ?? "trial",
		trialEndsAt: biz.trialEndsAt,
	};
}

export function canWrite(gate: BusinessGate): boolean {
	switch (gate.subscriptionStatus) {
		case "active":
			return true;
		case "trial":
			return gate.trialEndsAt === null || gate.trialEndsAt > new Date();
		default:
			return false;
	}
}

/** 402 quando a conta não pode escrever. Chame DEPOIS do auth middleware. */
export function requireWritableFactory(databaseUrl: string) {
	return async function requireWritable(
		c: Context<AppEnv>,
		next: Next,
	): Promise<globalThis.Response | undefined> {
		const db: Db = getDb(databaseUrl);
		const gate = await loadBusinessGate(db, c.get("authUser").uid);
		if (!gate) return c.json({ error: "user não encontrado" }, 404);
		if (!canWrite(gate)) {
			return c.json(
				{
					error: "assinatura necessária",
					hint: "Seu período de teste terminou. Renove a assinatura para continuar agendando.",
					subscription_status: gate.subscriptionStatus,
				},
				402,
			);
		}
		c.set("businessGate", gate);
		await next();
		return undefined;
	};
}
