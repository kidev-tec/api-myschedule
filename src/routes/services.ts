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

	routes.delete("/services/:id", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
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

/** PATCH /me — renomeia o business do usuário logado. */
export function meRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.patch("/me", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		if (!me) return c.json({ error: "user não encontrado" }, 404);

		const body = (await c.req.json().catch(() => null)) as {
			business_name?: unknown;
		} | null;
		const businessName =
			typeof body?.business_name === "string" ? body.business_name.trim() : "";
		if (businessName.length < 1 || businessName.length > 120) {
			return c.json({ error: "business_name obrigatório (1..120)" }, 400);
		}
		await db
			.update(businesses)
			.set({ name: businessName })
			.where(eq(businesses.id, me.businessId));
		return c.json({ ok: true, business_name: businessName });
	});

	return routes;
}
