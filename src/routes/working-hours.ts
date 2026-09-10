/**
 * Rotas de horários de trabalho (working_hours) — GET lista, PUT substitui.
 *
 * Contrato do app (booking_wizard + onboarding):
 * - GET  → [{ id, weekday, start_time, end_time }] (start_time = "HH:MM:SS")
 * - PUT  → { slots: [{ weekday, start_minute, end_minute }] } → replace total
 *   (delete-all + insert na mesma transação; weekday 0=dom..6=sáb)
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import { users, workingHours } from "../db/schema.js";
import type { AppEnv } from "../types.js";

type Slot = { weekday?: unknown; start_minute?: unknown; end_minute?: unknown };

function toTime(minuteOfDay: unknown): string | null {
	if (typeof minuteOfDay !== "number" || !Number.isInteger(minuteOfDay))
		return null;
	if (minuteOfDay < 0 || minuteOfDay > 1440) return null;
	const h = Math.floor(minuteOfDay / 60);
	const m = minuteOfDay % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

export function workingHoursRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.get("/working-hours", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const rows = await db
			.select()
			.from(workingHours)
			.where(eq(workingHours.userId, me.id));
		return c.json(
			rows.map((r) => ({
				id: r.id,
				weekday: r.weekday,
				start_time: r.startTime,
				end_time: r.endTime,
			})),
		);
	});

	routes.put("/working-hours", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);

		const body = (await c.req.json().catch(() => null)) as {
			slots?: Slot[];
		} | null;
		const slots = body?.slots;
		if (!Array.isArray(slots)) {
			return c.json({ error: "slots deve ser um array" }, 400);
		}

		const parsed: { weekday: number; startTime: string; endTime: string }[] =
			[];
		for (const s of slots) {
			const weekday = s.weekday;
			const start = toTime(s.start_minute);
			const end = toTime(s.end_minute);
			if (
				typeof weekday !== "number" ||
				weekday < 0 ||
				weekday > 6 ||
				start === null ||
				end === null
			) {
				return c.json({ error: `slot inválido: ${JSON.stringify(s)}` }, 400);
			}
			if (start >= end) {
				return c.json(
					{ error: `slot com fim antes do início: weekday=${weekday}` },
					400,
				);
			}
			parsed.push({ weekday, startTime: start, endTime: end });
		}

		// Replace total numa transação (delete-all + insert)
		await db.transaction(async (tx) => {
			await tx.delete(workingHours).where(eq(workingHours.userId, me.id));
			if (parsed.length > 0) {
				await tx.insert(workingHours).values(
					parsed.map((p) => ({
						userId: me.id,
						weekday: p.weekday,
						startTime: p.startTime,
						endTime: p.endTime,
					})),
				);
			}
		});

		const rows = await db
			.select()
			.from(workingHours)
			.where(eq(workingHours.userId, me.id));
		return c.json(
			rows.map((r) => ({
				id: r.id,
				weekday: r.weekday,
				start_time: r.startTime,
				end_time: r.endTime,
			})),
		);
	});

	return routes;
}
