/**
 * Painel da Oficina (escola) — B10.
 *
 * Rotas protegidas por SCHOOL_KEY (header x-school-key), separada da
 * INTERNAL_KEY. UI simples de gestão de assinantes:
 * - GET  /internal/school/subscribers?filter=expiring
 *      → lista businesses com status/trial, contato do dono, flag expiring
 *      (trial termina em <=3 dias) e expired
 * - POST /internal/school/renew { business_id, days? } → estende o trial
 *      (ou define expiresAt de assinatura ativa) e marca status 'active'
 *      quando days é omitido; com days, mantém 'trial' com nova data.
 *
 * Painel web consome essas rotas com o header secreto (leigo não tem acesso).
 */

import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import { businesses, users } from "../db/schema.js";
import type { AppEnv } from "../types.js";

export const EXPIRING_WINDOW_DAYS = 3;

function schoolAuthorized(c: {
	req: { header: (k: string) => string | undefined };
}): { ok: true } | { ok: false; status: 401 | 503; error: string } {
	const expected = process.env.SCHOOL_KEY;
	if (!expected)
		return { ok: false, status: 503, error: "SCHOOL_KEY não configurada" };
	if (c.req.header("x-school-key") !== expected) {
		return { ok: false, status: 401, error: "não autorizado" };
	}
	return { ok: true };
}

export function schoolRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.get("/internal/school/subscribers", async (c) => {
		const auth = schoolAuthorized(c);
		if (!auth.ok) return c.json({ error: auth.error }, auth.status);

		const filter = c.req.query("filter");
		const now = new Date();
		const expiringLimit = new Date(
			now.getTime() + EXPIRING_WINDOW_DAYS * 86_400_000,
		);

		const rows = await db
			.select({
				businessId: businesses.id,
				name: businesses.name,
				slug: businesses.slug,
				subscriptionStatus: businesses.subscriptionStatus,
				trialEndsAt: businesses.trialEndsAt,
				ownerEmail: sql<string>`min(${users.email})`,
				ownerName: sql<string>`min(${users.name})`,
			})
			.from(businesses)
			.leftJoin(users, eq(users.businessId, businesses.id))
			.groupBy(businesses.id)
			.orderBy(asc(businesses.trialEndsAt));

		const enriched = rows.map((r) => {
			const ends = r.trialEndsAt ? new Date(r.trialEndsAt) : null;
			const expired =
				r.subscriptionStatus === "trial" && ends !== null && ends <= now;
			const expiring =
				r.subscriptionStatus === "trial" &&
				ends !== null &&
				ends > now &&
				ends <= expiringLimit;
			return {
				business_id: r.businessId,
				name: r.name,
				slug: r.slug,
				subscription_status: r.subscriptionStatus,
				trial_ends_at: r.trialEndsAt,
				owner_email: r.ownerEmail,
				owner_name: r.ownerName,
				expired,
				expiring,
			};
		});

		const filtered =
			filter === "expiring"
				? enriched.filter((r) => r.expiring || r.expired)
				: enriched;

		return c.json({ subscribers: filtered, now: now.toISOString() });
	});

	routes.post("/internal/school/renew", async (c) => {
		const auth = schoolAuthorized(c);
		if (!auth.ok) return c.json({ error: auth.error }, auth.status);

		const body = (await c.req.json().catch(() => null)) as {
			business_id?: unknown;
			days?: unknown;
		} | null;
		if (
			typeof body?.business_id !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				body.business_id,
			)
		) {
			return c.json({ error: "business_id inválido" }, 400);
		}
		// days: estende trial (modo cortesia). Sem days: ativa assinatura paga.
		let days: number | null = null;
		if (body.days !== undefined) {
			if (
				typeof body.days !== "number" ||
				!Number.isInteger(body.days) ||
				body.days < 1 ||
				body.days > 365
			) {
				return c.json({ error: "days deve ser inteiro 1..365" }, 400);
			}
			days = body.days;
		}

		const [biz] = await db
			.select()
			.from(businesses)
			.where(eq(businesses.id, body.business_id))
			.limit(1);
		if (!biz) return c.json({ error: "business não encontrado" }, 404);

		const now = new Date();
		if (days === null) {
			// ativação de assinatura: 30 dias padrão de validade
			const expires = new Date(now.getTime() + 30 * 86_400_000);
			await db
				.update(businesses)
				.set({ subscriptionStatus: "active", trialEndsAt: expires })
				.where(eq(businesses.id, biz.id));
			return c.json({
				ok: true,
				subscription_status: "active",
				trial_ends_at: expires.toISOString(),
			});
		}

		// renovação de trial: base = max(now, trial atual) pra acumular dias
		const base =
			biz.trialEndsAt && biz.trialEndsAt > now ? biz.trialEndsAt : now;
		const newEnds = new Date(base.getTime() + days * 86_400_000);
		await db
			.update(businesses)
			.set({ subscriptionStatus: "trial", trialEndsAt: newEnds })
			.where(eq(businesses.id, biz.id));
		return c.json({
			ok: true,
			subscription_status: "trial",
			trial_ends_at: newEnds.toISOString(),
		});
	});

	return routes;
}
