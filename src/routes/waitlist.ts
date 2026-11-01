/**
 * Lista de espera (F5, migration 0016).
 *
 * - POST   /p/:slug/waitlist          — PÚBLICO: cliente entra na lista do dia
 *                                      { name, phone, desired_date } (aceita
 *                                      client_name também — contrato antigo)
 * - GET    /waitlist?date=YYYY-MM-DD  — prestador vê quem espera no dia (auth)
 * - POST   /waitlist                  — prestador adiciona (cliente pediu por
 *                                      telefone/WhatsApp): { client_id } ou
 *                                      { name, phone } + desired_date
 * - PATCH  /waitlist/:id              — marca waiting/notified/served
 * - DELETE /waitlist/:id              — tira da lista
 *
 * Celular: só dígitos, com ou sem 55 (mesma regra do agendamento pelo link),
 * reaproveitando o cadastro ativo do cliente. Vaga aberta: a rota de
 * cancelamento conta quem espera no dia (fuso do negócio) e notifica.
 */

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import { businesses, clients, users, waitlist } from "../db/schema.js";
import { phoneDigitsBr, phoneMatchKeys } from "../domain/phone-br.js";
import { dayKey } from "../domain/schedule-day.js";
import type { AppEnv } from "../types.js";
import { rateLimited } from "./public-booking.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "2026-11-03" → "03/11" (mensagens). */
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

type Body = {
	name?: unknown;
	client_name?: unknown;
	phone?: unknown;
	desired_date?: unknown;
	client_id?: unknown;
} | null;

/** Valida a data: formato e de hoje em diante (fuso do negócio). */
function dateError(date: string, timeZone: string): string | null {
	if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) {
		return "Escolha o dia da lista de espera";
	}
	if (date < dayKey(new Date(), timeZone)) {
		return "Esse dia já passou — escolha hoje ou um dia futuro";
	}
	return null;
}

export function waitlistRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	/** Cliente ativo com esse celular (só dígitos, com/sem 55) ou novo. */
	async function clientByPhone(
		businessId: string,
		name: string,
		phone: string,
		origin: "public_link" | "app",
	) {
		const [found] = await db
			.select({ id: clients.id, name: clients.name, phone: clients.phoneE164 })
			.from(clients)
			.where(
				and(
					eq(clients.businessId, businessId),
					isNull(clients.deletedAt),
					inArray(
						sql`regexp_replace(${clients.phoneE164}, '[^0-9]', '', 'g')`,
						phoneMatchKeys(phone),
					),
				),
			)
			.orderBy(asc(clients.createdAt))
			.limit(1);
		if (found) return found;
		const [created] = await db
			.insert(clients)
			.values({
				businessId,
				name,
				phoneE164: phoneDigitsBr(phone),
				origin,
			})
			.returning({
				id: clients.id,
				name: clients.name,
				phone: clients.phoneE164,
			});
		/* v8 ignore next -- INSERT..RETURNING nunca vazio */
		if (!created) throw new Error("falha ao criar cliente");
		return created;
	}

	/** Insere na lista; null = já estava na lista desse dia. */
	async function addEntry(
		businessId: string,
		client: { id: string; phone: string },
		date: string,
	): Promise<string | null> {
		const [row] = await db
			.insert(waitlist)
			.values({
				businessId,
				clientId: client.id,
				desiredDate: date,
				phoneE164: phoneDigitsBr(client.phone),
			})
			.onConflictDoNothing()
			.returning({ id: waitlist.id });
		return row?.id ?? null;
	}

	function readNamePhone(body: Body) {
		const rawName = body?.name ?? body?.client_name;
		const name = typeof rawName === "string" ? rawName.trim() : "";
		const phone = typeof body?.phone === "string" ? body.phone : "";
		if (name.length < 1 || name.length > 120) {
			return { error: "Informe o nome" } as const;
		}
		if (phone.replace(/\D/g, "").length < 10) {
			return { error: "Informe um WhatsApp válido, com DDD" } as const;
		}
		return { name, phone } as const;
	}

	// PÚBLICO: cliente entra na lista (sem auth — vem do link de agendamento)
	routes.post("/p/:slug/waitlist", async (c) => {
		const ip =
			c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
		if (rateLimited(`waitlist:${ip}`, 10, 60_000)) {
			return c.json(
				{ error: "Muitas tentativas. Aguarde um minuto e tente de novo." },
				429,
			);
		}
		const [biz] = await db
			.select({ id: businesses.id, timezone: businesses.timezone })
			.from(businesses)
			.where(eq(businesses.slug, c.req.param("slug")))
			.limit(1);
		if (!biz) return c.json({ error: "Link não encontrado" }, 404);

		const body = (await c.req.json().catch(() => null)) as Body;
		const np = readNamePhone(body);
		if ("error" in np) return c.json({ error: np.error }, 400);
		const date =
			typeof body?.desired_date === "string" ? body.desired_date.trim() : "";
		const bad = dateError(date, biz.timezone);
		if (bad) return c.json({ error: bad }, 400);

		const client = await clientByPhone(
			biz.id,
			np.name,
			np.phone,
			"public_link",
		);
		const id = await addEntry(biz.id, client, date);
		if (!id) {
			return c.json(
				{ error: `Você já está na lista de espera de ${ddmm(date)}` },
				409,
			);
		}
		return c.json({ ok: true, id, desired_date: date }, 201);
	});

	async function meOf(uid: string) {
		const [me] = await db
			.select({
				businessId: users.businessId,
				timezone: businesses.timezone,
			})
			.from(users)
			.innerJoin(businesses, eq(businesses.id, users.businessId))
			.where(eq(users.firebaseUid, uid))
			.limit(1);
		return me;
	}

	// AUTH: prestador vê a lista de espera de um dia (ordem de chegada)
	routes.get("/waitlist", async (c) => {
		const me = await meOf(c.get("authUser").uid);
		/* v8 ignore next -- inatingível: auth retorna antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const date = c.req.query("date") ?? "";
		if (!DATE_RE.test(date)) {
			return c.json({ error: "Escolha o dia da lista de espera" }, 400);
		}
		const rows = await db
			.select({
				id: waitlist.id,
				clientId: waitlist.clientId,
				clientName: clients.name,
				phone: waitlist.phoneE164,
				status: waitlist.status,
				createdAt: waitlist.createdAt,
			})
			.from(waitlist)
			.innerJoin(clients, eq(clients.id, waitlist.clientId))
			.where(
				and(
					eq(waitlist.businessId, me.businessId),
					sql`${waitlist.desiredDate}::date = ${date}::date`,
				),
			)
			.orderBy(asc(waitlist.createdAt));
		return c.json({
			waitlist: rows.map((r) => ({
				id: r.id,
				client_id: r.clientId,
				client_name: r.clientName,
				phone: r.phone,
				status: r.status,
				created_at: r.createdAt.toISOString(),
			})),
		});
	});

	// AUTH: prestador adiciona alguém (pedido por telefone/WhatsApp)
	routes.post("/waitlist", async (c) => {
		const me = await meOf(c.get("authUser").uid);
		/* v8 ignore next -- inatingível: auth retorna antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const body = (await c.req.json().catch(() => null)) as Body;
		const date =
			typeof body?.desired_date === "string" ? body.desired_date.trim() : "";
		const bad = dateError(date, me.timezone);
		if (bad) return c.json({ error: bad }, 400);

		let client: { id: string; name: string; phone: string } | undefined;
		if (body?.client_id !== undefined) {
			if (typeof body.client_id !== "string" || !UUID_RE.test(body.client_id)) {
				return c.json({ error: "Cliente não encontrado" }, 404);
			}
			[client] = await db
				.select({
					id: clients.id,
					name: clients.name,
					phone: clients.phoneE164,
				})
				.from(clients)
				.where(
					and(
						eq(clients.id, body.client_id),
						eq(clients.businessId, me.businessId),
						isNull(clients.deletedAt),
					),
				)
				.limit(1);
			if (!client) return c.json({ error: "Cliente não encontrado" }, 404);
		} else {
			const np = readNamePhone(body);
			if ("error" in np) return c.json({ error: np.error }, 400);
			client = await clientByPhone(me.businessId, np.name, np.phone, "app");
		}
		const id = await addEntry(me.businessId, client, date);
		if (!id) {
			return c.json(
				{
					error: `${client.name} já está na lista de espera de ${ddmm(date)}`,
				},
				409,
			);
		}
		return c.json({ ok: true, id, client_name: client.name }, 201);
	});

	// AUTH: marca aguardando/avisado/atendido
	routes.patch("/waitlist/:id", async (c) => {
		const me = await meOf(c.get("authUser").uid);
		/* v8 ignore next -- inatingível: auth retorna antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) {
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
			return c.json({ error: "Essa pessoa não está mais na lista" }, 404);
		}
		return c.json({ ok: true });
	});

	// AUTH: tira da lista
	routes.delete("/waitlist/:id", async (c) => {
		const me = await meOf(c.get("authUser").uid);
		/* v8 ignore next -- inatingível: auth retorna antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) {
			return c.json({ error: "id inválido" }, 400);
		}
		const gone = await db
			.delete(waitlist)
			.where(and(eq(waitlist.id, id), eq(waitlist.businessId, me.businessId)))
			.returning({ id: waitlist.id });
		if (gone.length === 0) {
			return c.json({ error: "Essa pessoa não está mais na lista" }, 404);
		}
		return c.json({ ok: true });
	});

	return routes;
}
