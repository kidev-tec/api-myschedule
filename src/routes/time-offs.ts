/**
 * Rotas de bloqueio de agenda (F3, migration 0015).
 *
 * - GET    /time-offs         — lista bloqueios futuros do profissional
 * - POST   /time-offs         — cria bloqueio { starts_at, ends_at, reason? }
 * - DELETE /time-offs/:id     — remove bloqueio
 *
 * Regras: ends_at > starts_at; não pode engolhar agendamento ativo existente
 * (409 se houver appointment pending/confirmed no intervalo).
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import {
	appointments,
	timeOffs as timeOffsTable,
	users,
} from "../db/schema.js";
import type { AppEnv } from "../types.js";

function isIsoDate(v: unknown): v is string {
	return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

export function timeOffRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.get("/time-offs", async (c) => {
		const authUser = c.get("authUser");
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, authUser.uid))
				.limit(1)
		)[0];
		/* v8 ignore next -- inatingível: auth retorna antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);

		const rows = await db
			.select()
			.from(timeOffsTable)
			.where(
				and(
					eq(timeOffsTable.userId, me.id),
					gte(timeOffsTable.endsAt, new Date()),
				),
			);
		return c.json(
			rows.map((t) => ({
				id: t.id,
				reason: t.reason,
				starts_at: t.startsAt.toISOString(),
				ends_at: t.endsAt.toISOString(),
			})),
		);
	});

	routes.post("/time-offs", async (c) => {
		const authUser = c.get("authUser");
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, authUser.uid))
				.limit(1)
		)[0];
		/* v8 ignore next -- inatingível: auth retorna antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);

		const body = (await c.req.json().catch(() => null)) as {
			starts_at?: unknown;
			ends_at?: unknown;
			reason?: unknown;
		} | null;
		if (!isIsoDate(body?.starts_at) || !isIsoDate(body?.ends_at)) {
			return c.json(
				{ error: "starts_at e ends_at são obrigatórios (ISO 8601)" },
				400,
			);
		}
		const startsAt = new Date(body!.starts_at!);
		const endsAt = new Date(body!.ends_at!);
		if (endsAt <= startsAt) {
			return c.json({ error: "ends_at deve ser depois de starts_at" }, 400);
		}
		const reason =
			typeof body?.reason === "string" && body.reason.trim()
				? body.reason.trim().slice(0, 120)
				: null;

		// não pode engolir agendamento ativo existente
		const conflict = await db
			.select({ id: appointments.id })
			.from(appointments)
			.where(
				and(
					eq(appointments.userId, me.id),
					sql`${appointments.status} IN ('pending', 'confirmed')`,
					sql`${appointments.startsAt} < ${endsAt.toISOString()}`,
					sql`${appointments.endsAt} > ${startsAt.toISOString()}`,
				),
			)
			.limit(1);
		if (conflict.length > 0) {
			return c.json(
				{
					error:
						"Já existe agendamento ativo nesse intervalo. Cancela ou remarca antes de bloquear.",
				},
				409,
			);
		}

		const created = (
			await db
				.insert(timeOffsTable)
				.values({
					userId: me.id,
					businessId: me.businessId,
					reason,
					startsAt,
					endsAt,
				})
				.returning()
		)[0];
		/* v8 ignore next -- INSERT..RETURNING nunca vazio */
		if (!created) return c.json({ error: "falha ao criar bloqueio" }, 500);
		return c.json(
			{
				id: created.id,
				reason: created.reason,
				starts_at: created.startsAt.toISOString(),
				ends_at: created.endsAt.toISOString(),
			},
			201,
		);
	});

	routes.delete("/time-offs/:id", async (c) => {
		const authUser = c.get("authUser");
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, authUser.uid))
				.limit(1)
		)[0];
		/* v8 ignore next -- inatingível: auth retorna antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!/^[0-9a-f-]{36}$/i.test(id)) {
			return c.json({ error: "id inválido" }, 400);
		}
		const deleted = await db
			.delete(timeOffsTable)
			.where(and(eq(timeOffsTable.id, id), eq(timeOffsTable.userId, me.id)))
			.returning({ id: timeOffsTable.id });
		if (deleted.length === 0) {
			return c.json({ error: "bloqueio não encontrado" }, 404);
		}
		return c.json({ ok: true });
	});

	return routes;
}
