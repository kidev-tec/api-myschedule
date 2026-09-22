/**
 * Lista de espera (F5, migration 0016).
 *
 * - POST /p/:slug/waitlist        — PÚBLICO: cliente entra na lista do dia
 *                                   { client_name, phone, desired_date }
 * - GET    /waitlist?date=YYYY-MM-DD — prestador vê quem espera no dia (auth)
 * - PATCH  /waitlist/:id          — marca notified/served (auth)
 *
 * Notificação de vaga: a rota de cancelamento chama notifyWaitlistForDay
 * e manda push pro prestador com a lista de interessados.
 */

import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import { businesses, clients, users, waitlist } from "../db/schema.js";
import type { AppEnv } from "../types.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RE = /^\+[1-9]\d{10,14}$/;

export function waitlistRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	// PÚBLICO: cliente entra na lista (sem auth — vem do link de booking)
	routes.post("/p/:slug/waitlist", async (c) => {
		const slug = c.req.param("slug");
		const biz = (
			await db
				.select()
				.from(businesses)
				.where(eq(businesses.slug, slug))
				.limit(1)
		)[0];
		if (!biz) {
			return c.json({ error: "link não encontrado" }, 404);
		}

		const body = (await c.req.json().catch(() => null)) as {
			client_name?: unknown;
			phone?: unknown;
			desired_date?: unknown;
		} | null;
		const name =
			typeof body?.client_name === "string" ? body.client_name.trim() : "";
		const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
		const date =
			typeof body?.desired_date === "string" ? body.desired_date.trim() : "";
		if (name.length < 1 || name.length > 120) {
			return c.json({ error: "client_name deve ter 1..120 caracteres" }, 400);
		}
		if (!PHONE_RE.test(phone)) {
			return c.json({ error: "phone deve ser E.164 (+5511999999999)" }, 400);
		}
		if (!DATE_RE.test(date)) {
			return c.json({ error: "desired_date deve ser YYYY-MM-DD" }, 400);
		}

		// upsert do cliente por telefone (mesma lógica do booking público)
		let clientId: string;
		const existing = await db
			.select({ id: clients.id })
			.from(clients)
			.where(and(eq(clients.businessId, biz.id), eq(clients.phoneE164, phone)))
			.limit(1);
		if (existing[0]) {
			clientId = existing[0].id;
		} else {
			const created = (
				await db
					.insert(clients)
					.values({ businessId: biz.id, name, phoneE164: phone })
					.returning({ id: clients.id })
			)[0];
			/* v8 ignore next -- INSERT..RETURNING nunca vazio */
			if (!created) return c.json({ error: "falha ao entrar na lista" }, 500);
			clientId = created.id;
		}

		try {
			const row = (
				await db
					.insert(waitlist)
					.values({
						businessId: biz.id,
						clientId,
						desiredDate: date,
						phoneE164: phone,
					})
					.returning({ id: waitlist.id })
			)[0];
			/* v8 ignore next -- INSERT..RETURNING nunca vazio */
			if (!row) return c.json({ error: "falha ao entrar na lista" }, 500);
			return c.json({ ok: true, id: row.id }, 201);
		} catch (err) {
			// 23505 = já está na lista desse dia (Drizzle envelopa em cause)
			const cause = (err as { cause?: { code?: string } }).cause;
			/* v8 ignore next -- cause undefined só em falha de conexão */
			if (cause?.code === "23505") {
				return c.json({ error: "você já está na lista desse dia" }, 409);
			}
			/* v8 ignore next -- único erro tratável do INSERT é o 23505; demais são
			   falhas de conexão (banco fora = request já falhou antes) */
			throw err;
		}
	});

	// AUTH: prestador vê a lista de espera de um dia
	routes.get("/waitlist", async (c) => {
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, c.get("authUser").uid))
				.limit(1)
		)[0];
		/* v8 ignore next -- inatingível: auth retorna antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const date = c.req.query("date") ?? "";
		if (!DATE_RE.test(date)) {
			return c.json({ error: "date deve ser YYYY-MM-DD" }, 400);
		}
		const rows = await db
			.select({
				id: waitlist.id,
				clientName: clients.name,
				phone: waitlist.phoneE164,
				status: waitlist.status,
			})
			.from(waitlist)
			.innerJoin(clients, eq(clients.id, waitlist.clientId))
			.where(
				and(
					eq(waitlist.businessId, me.businessId),
					sql`${waitlist.desiredDate}::date = ${date}::date`,
				),
			);
		return c.json({
			waitlist: rows.map((r) => ({
				id: r.id,
				client_name: r.clientName,
				phone: r.phone,
				status: r.status,
			})),
		});
	});

	// AUTH: marca como notificado/atendido
	routes.patch("/waitlist/:id", async (c) => {
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, c.get("authUser").uid))
				.limit(1)
		)[0];
		/* v8 ignore next -- inatingível: auth retorna antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!/^[0-9a-f-]{36}$/i.test(id)) {
			return c.json({ error: "id inválido" }, 400);
		}
		const body = (await c.req.json().catch(() => null)) as {
			status?: unknown;
		} | null;
		const status = body?.status;
		if (status !== "notified" && status !== "served" && status !== "waiting") {
			return c.json(
				{ error: "status inválido (waiting|notified|served)" },
				400,
			);
		}
		const updated = await db
			.update(waitlist)
			.set({ status })
			.where(and(eq(waitlist.id, id), eq(waitlist.businessId, me.businessId)))
			.returning({ id: waitlist.id });
		if (updated.length === 0) {
			return c.json({ error: "entrada não encontrada" }, 404);
		}
		return c.json({ ok: true });
	});

	return routes;
}
