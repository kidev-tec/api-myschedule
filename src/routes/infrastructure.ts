/**
 * Rotas de infraestrutura 2026-09-16:
 * - POST/DELETE /devices — registro de token FCM (auth obrigatória)
 * - GET  /businesses/:slug/logo — logo pública (sem auth; app + link de agendamento)
 * - POST /internal/trial-reminders — lembretes de trial por email (header secreto)
 */

import { and, eq, gt, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import { businesses, deviceTokens, users } from "../db/schema.js";
import { sendEmail, trialEndingEmail } from "../services/email.js";
import type { AppEnv } from "../types.js";

export function deviceRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.post("/devices", async (c) => {
		const authUser = c.get("authUser");
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, authUser.uid))
				.limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall/auth retorna antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);

		const body = (await c.req.json().catch(() => null)) as {
			fcmToken?: unknown;
			platform?: unknown;
		} | null;
		const token =
			typeof body?.fcmToken === "string" ? body.fcmToken.trim() : "";
		const platform = body?.platform;
		if (token.length < 10) {
			return c.json({ error: "fcmToken inválido" }, 400);
		}
		if (platform !== "android" && platform !== "ios") {
			return c.json({ error: "platform deve ser android ou ios" }, 400);
		}
		await db
			.insert(deviceTokens)
			.values({ userId: me.id, fcmToken: token, platform })
			.onConflictDoUpdate({
				target: deviceTokens.fcmToken,
				set: { userId: me.id, platform, updatedAt: new Date() },
			});
		return c.json({ ok: true }, 201);
	});

	routes.delete("/devices", async (c) => {
		const body = (await c.req.json().catch(() => null)) as {
			fcmToken?: unknown;
		} | null;
		const token =
			typeof body?.fcmToken === "string" ? body.fcmToken.trim() : "";
		if (token.length < 10) {
			return c.json({ error: "fcmToken inválido" }, 400);
		}
		await db.delete(deviceTokens).where(eq(deviceTokens.fcmToken, token));
		return c.body(null, 204);
	});

	return routes;
}

/** Logo pública do business — servida direto do Postgres (bytea). */
export function logoRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.get("/businesses/:slug/logo", async (c) => {
		const biz = (
			await db
				.select()
				.from(businesses)
				.where(eq(businesses.slug, c.req.param("slug")))
				.limit(1)
		)[0];
		if (!biz?.logoData || !biz.logoMime) {
			return c.json({ error: "logo não encontrada" }, 404);
		}
		c.header("Content-Type", biz.logoMime);
		c.header("Cache-Control", "public, max-age=300");
		return c.body(new Uint8Array(biz.logoData));
	});

	return routes;
}

/**
 * Lembrete de trial terminando (chamado por cron externo 1x/dia).
 * Proteção: header x-internal-key === INTERNAL_KEY (401 errado/ausente;
 * 503 se INTERNAL_KEY não configurado — fail-closed).
 */
export function internalRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.post("/internal/trial-reminders", async (c) => {
		const expected = process.env.INTERNAL_KEY;
		if (!expected) {
			return c.json({ error: "INTERNAL_KEY não configurada" }, 503);
		}
		if (c.req.header("x-internal-key") !== expected) {
			return c.json({ error: "não autorizado" }, 401);
		}

		const now = new Date();
		const in3Days = new Date(now.getTime() + 3 * 86_400_000);
		// trial termina entre agora e 3 dias; ainda não lembrou hoje
		const rows = await db
			.select()
			.from(businesses)
			.where(
				and(
					eq(businesses.subscriptionStatus, "trial"),
					gt(businesses.trialEndsAt, now),
					lte(businesses.trialEndsAt, in3Days),
					sql`(${businesses.trialReminderSentAt} IS NULL OR ${businesses.trialReminderSentAt} < now() - interval '20 hours')`,
				),
			);

		let sent = 0;
		for (const biz of rows) {
			/* v8 ignore next -- query filtra trial_ends_at > now(), nunca null aqui */
			const daysLeft = Math.ceil(
				(biz.trialEndsAt!.getTime() - now.getTime()) / 86_400_000,
			);
			const owner = (
				await db
					.select()
					.from(users)
					.where(eq(users.businessId, biz.id))
					.limit(1)
			)[0];
			/* v8 ignore next -- todo business nasce com owner (sync) */
			if (!owner) continue;
			const payload = trialEndingEmail(biz.name, daysLeft);
			await sendEmail({ ...payload, to: owner.email });
			await db
				.update(businesses)
				.set({ trialReminderSentAt: now })
				.where(eq(businesses.id, biz.id));
			sent++;
		}
		return c.json({ sent, checked: rows.length });
	});

	return routes;
}
