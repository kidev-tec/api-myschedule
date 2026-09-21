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

const DIAS_SEMANA = [
	"domingo",
	"segunda-feira",
	"terça-feira",
	"quarta-feira",
	"quinta-feira",
	"sexta-feira",
	"sábado",
];

function toTime(minuteOfDay: unknown): string | null {
	if (typeof minuteOfDay !== "number" || !Number.isInteger(minuteOfDay))
		return null;
	if (minuteOfDay < 0 || minuteOfDay > 1440) return null;
	const h = Math.floor(minuteOfDay / 60);
	const m = minuteOfDay % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

/**
 * Overlap entre intervalos do MESMO dia → 400 com o nome do dia
 * ("Horários se sobrepõem na terça-feira"). Intervalos que só se
 * encostam (14:00-16:00 e 16:00-18:00) são válidos.
 */
function acharOverlap(
	parsed: { weekday: number; start: number; end: number }[],
): string | null {
	const porDia = new Map<number, { start: number; end: number }[]>();
	for (const p of parsed) {
		const lista = porDia.get(p.weekday) ?? [];
		lista.push({ start: p.start, end: p.end });
		porDia.set(p.weekday, lista);
	}
	for (const [weekday, intervalos] of porDia) {
		intervalos.sort((a, b) => a.start - b.start);
		for (let i = 1; i < intervalos.length; i++) {
			const prev = intervalos[i - 1];
			const cur = intervalos[i];
			if (prev && cur && cur.start < prev.end) {
				/* v8 ignore next -- weekday validado 0..6 antes; fallback defensivo */
				return DIAS_SEMANA[weekday] ?? `dia ${weekday}`;
			}
		}
	}
	return null;
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

		const parsed: {
			weekday: number;
			startTime: string;
			endTime: string;
			start: number;
			end: number;
		}[] = [];
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
			parsed.push({
				weekday,
				startTime: start,
				endTime: end,
				start: s.start_minute as number,
				end: s.end_minute as number,
			});
		}

		// BARRA B4: intervalos do mesmo dia não podem se sobrepor
		const diaOverlap = acharOverlap(parsed);
		if (diaOverlap) {
			return c.json({ error: `Horários se sobrepõem na ${diaOverlap}` }, 400);
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
