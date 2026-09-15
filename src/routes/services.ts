/**
 * Rotas de serviços + perfil do negócio (onboarding passo 1 e 2).
 *
 * Contrato do app:
 * - GET    /services → [{ id, name, duration_min, price_cents, archived_at }]
 * - POST   /services { name, duration_min, price_cents } → cria
 * - GET    /services/:id → um serviço
 * - DELETE /services/:id → soft-delete (archived_at)
 * - PATCH  /me { business_name } → renomeia o business do usuário
 */

import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import { businesses, services, users } from "../db/schema.js";
import type { AppEnv } from "../types.js";

function serialize(r: typeof services.$inferSelect) {
	return {
		id: r.id,
		name: r.name,
		duration_min: r.durationMin,
		price_cents: r.priceCents,
		archived_at: r.archivedAt,
	};
}

export function servicesRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.get("/services", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const rows = await db
			.select()
			.from(services)
			.where(
				and(
					eq(services.businessId, me.businessId),
					isNull(services.archivedAt),
				),
			);
		return c.json(rows.map(serialize));
	});

	routes.post("/services", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);

		const body = (await c.req.json().catch(() => null)) as {
			name?: unknown;
			duration_min?: unknown;
			price_cents?: unknown;
		} | null;
		const name = typeof body?.name === "string" ? body.name.trim() : "";
		const durationMin = body?.duration_min;
		const priceCents = body?.price_cents;
		if (
			name.length < 1 ||
			typeof durationMin !== "number" ||
			durationMin < 5 ||
			durationMin > 600 ||
			typeof priceCents !== "number" ||
			priceCents < 0
		) {
			return c.json(
				{
					error:
						"campos obrigatórios: name (str), duration_min (5..600), price_cents (>=0)",
				},
				400,
			);
		}
		const created = (
			await db
				.insert(services)
				.values({
					businessId: me.businessId,
					name,
					durationMin,
					priceCents,
				})
				.returning()
		)[0];
		/* v8 ignore next -- defensivo: INSERT..RETURNING nunca é vazio no Postgres */
		if (!created) return c.json({ error: "falha ao criar serviço" }, 500);
		return c.json(serialize(created), 201);
	});

	routes.get("/services/:id", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!/^[0-9a-f-]{36}$/i.test(id))
			return c.json({ error: "id inválido" }, 400);
		const rows = await db
			.select()
			.from(services)
			.where(
				and(
					eq(services.id, id),
					eq(services.businessId, me.businessId),
					isNull(services.archivedAt),
				),
			)
			.limit(1);
		const row = rows[0];
		if (!row) return c.json({ error: "serviço não encontrado" }, 404);
		return c.json(serialize(row));
	});

	/** PATCH /services/:id — edita nome/duração/preço (disponibilidade = arquivar/recriar). */
	routes.patch("/services/:id", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!/^[0-9a-f-]{36}$/i.test(id))
			return c.json({ error: "id inválido" }, 400);

		const body = (await c.req.json().catch(() => null)) as {
			name?: unknown;
			duration_min?: unknown;
			price_cents?: unknown;
		} | null;

		const updates: {
			name?: string;
			durationMin?: number;
			priceCents?: number;
		} = {};
		if (body?.name !== undefined) {
			if (
				typeof body.name !== "string" ||
				body.name.trim().length < 1 ||
				body.name.trim().length > 120
			)
				return c.json({ error: "name deve ter 1..120 caracteres" }, 400);
			updates.name = body.name.trim();
		}
		if (body?.duration_min !== undefined) {
			if (
				typeof body.duration_min !== "number" ||
				body.duration_min < 5 ||
				body.duration_min > 600
			)
				return c.json({ error: "duration_min deve ser 5..600" }, 400);
			updates.durationMin = body.duration_min;
		}
		if (body?.price_cents !== undefined) {
			if (typeof body.price_cents !== "number" || body.price_cents < 0)
				return c.json({ error: "price_cents deve ser >= 0" }, 400);
			updates.priceCents = body.price_cents;
		}
		if (Object.keys(updates).length === 0)
			return c.json({ error: "nada para atualizar" }, 400);

		const updated = await db
			.update(services)
			.set(updates)
			.where(
				and(
					eq(services.id, id),
					eq(services.businessId, me.businessId),
					isNull(services.archivedAt),
				),
			)
			.returning();
		const upd = updated[0];
		if (!upd) return c.json({ error: "serviço não encontrado" }, 404);
		return c.json(serialize(upd));
	});

	routes.delete("/services/:id", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!/^[0-9a-f-]{36}$/i.test(id))
			return c.json({ error: "id inválido" }, 400);
		const updated = await db
			.update(services)
			.set({ archivedAt: new Date() })
			.where(and(eq(services.id, id), eq(services.businessId, me.businessId)))
			.returning();
		const upd = updated[0];
		if (!upd) return c.json({ error: "serviço não encontrado" }, 404);
		return c.json(serialize(upd));
	});

	return routes;
}

/** GET/PATCH /me — lê/atualiza o business do usuário logado (nome + segmento). */
export function meRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.get("/me", async (c) => {
		const authUser = c.get("authUser");
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, authUser.uid))
				.limit(1)
		)[0];
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const biz = (
			await db
				.select()
				.from(businesses)
				.where(eq(businesses.id, me.businessId))
				.limit(1)
		)[0];
		/* v8 ignore next -- defensivo: user sempre tem business (FK NOT NULL + sync) */
		if (!biz) return c.json({ error: "business não encontrado" }, 404);
		return c.json({
			id: biz.id,
			name: biz.name,
			slug: biz.slug,
			business_type: biz.businessType,
			timezone: biz.timezone,
			subscription_status: biz.subscriptionStatus,
			trial_ends_at: biz.trialEndsAt,
		});
	});

	routes.patch("/me", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);

		const body = (await c.req.json().catch(() => null)) as {
			business_name?: unknown;
			business_type?: unknown;
		} | null;
		// PATCH parcial: cada campo é opcional, mas se vier tem que ser válido.
		// (ensureProvisioned do app faz PATCH só com business_type; o
		// onboarding manda nome + segmento.)
		let businessName: string | undefined;
		if (body?.business_name !== undefined) {
			if (typeof body.business_name !== "string") {
				return c.json({ error: "business_name deve ser string" }, 400);
			}
			const trimmed = body.business_name.trim();
			if (trimmed.length < 1 || trimmed.length > 120) {
				return c.json({ error: "business_name deve ter 1..120 caracteres" }, 400);
			}
			businessName = trimmed;
		}
		// PATCH sem nenhum campo conhecido (body null/quebrado/vazio) → 400.
		if (businessName === undefined && body?.business_type === undefined) {
			return c.json({ error: "nada para atualizar" }, 400);
		}
		// Segmento: opcional; se vier, valida contra a whitelist de presets.
		const SEGMENT_IDS = [
			"beauty",
			"barber",
			"dental",
			"medical",
			"auto_detailing",
			"pet_grooming",
			"veterinary",
			"mechanic",
			"other",
		] as const;
		let businessType: string | undefined;
		if (body?.business_type !== undefined) {
			if (
				typeof body.business_type !== "string" ||
				!(SEGMENT_IDS as readonly string[]).includes(body.business_type)
			) {
				return c.json({ error: "business_type inválido" }, 400);
			}
			businessType = body.business_type;
		}
		await db
			.update(businesses)
			.set({
				...(businessName !== undefined ? { name: businessName } : {}),
				...(businessType ? { businessType } : {}),
			})
			.where(eq(businesses.id, me.businessId));
		return c.json({
			ok: true,
			business_name: businessName ?? null,
			business_type: businessType ?? null,
		});
	});

	return routes;
}
