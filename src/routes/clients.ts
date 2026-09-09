/**
 * Rotas de clientes — GET lista, POST cria, GET/DELETE por id (soft-delete).
 *
 * Contrato do app (clients_page, client_form_page, booking_wizard):
 * - GET  /clients → [{ id, name, phone_e164, email }]
 * - POST /clients { name, phone_e164, email? } → cria
 * - GET  /clients/:id
 * - DELETE /clients/:id → soft-delete (deleted_at)
 */

import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import { clients, users } from "../db/schema.js";
import type { AppEnv } from "../types.js";

function serialize(r: typeof clients.$inferSelect) {
	return {
		id: r.id,
		name: r.name,
		phone_e164: r.phoneE164,
		email: r.email,
		birthday: r.birthday,
		notes: r.notes,
	};
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function clientsRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.get("/clients", async (c) => {
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, c.get("authUser").uid))
				.limit(1)
		)[0];
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const rows = await db
			.select()
			.from(clients)
			.where(
				and(eq(clients.businessId, me.businessId), isNull(clients.deletedAt)),
			);
		return c.json(rows.map(serialize));
	});

	routes.post("/clients", async (c) => {
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, c.get("authUser").uid))
				.limit(1)
		)[0];
		if (!me) return c.json({ error: "user não encontrado" }, 404);

		const body = (await c.req.json().catch(() => null)) as {
			name?: unknown;
			phone_e164?: unknown;
			email?: unknown;
		} | null;
		const name = typeof body?.name === "string" ? body.name.trim() : "";
		const phone =
			typeof body?.phone_e164 === "string" ? body.phone_e164.trim() : "";
		const email =
			typeof body?.email === "string" && body.email.trim() !== ""
				? body.email.trim()
				: null;
		if (name.length < 1 || phone.length < 10) {
			return c.json(
				{ error: "name obrigatório e phone_e164 válido (>=10 dígitos)" },
				400,
			);
		}
		const created = (
			await db
				.insert(clients)
				.values({ businessId: me.businessId, name, phoneE164: phone, email })
				.returning()
		)[0];
		/* v8 ignore next -- defensivo: INSERT..RETURNING nunca é vazio no Postgres */
		if (!created) return c.json({ error: "falha ao criar cliente" }, 500);
		return c.json(serialize(created), 201);
	});

	routes.get("/clients/:id", async (c) => {
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, c.get("authUser").uid))
				.limit(1)
		)[0];
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) return c.json({ error: "id inválido" }, 400);
		const rows = await db
			.select()
			.from(clients)
			.where(
				and(
					eq(clients.id, id),
					eq(clients.businessId, me.businessId),
					isNull(clients.deletedAt),
				),
			)
			.limit(1);
		const row = rows[0];
		if (!row) return c.json({ error: "cliente não encontrado" }, 404);
		return c.json(serialize(row));
	});

	routes.delete("/clients/:id", async (c) => {
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, c.get("authUser").uid))
				.limit(1)
		)[0];
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) return c.json({ error: "id inválido" }, 400);
		const updated = await db
			.update(clients)
			.set({ deletedAt: new Date() })
			.where(and(eq(clients.id, id), eq(clients.businessId, me.businessId)))
			.returning();
		const upd = updated[0];
		if (!upd) return c.json({ error: "cliente não encontrado" }, 404);
		return c.json(serialize(upd));
	});

	return routes;
}
