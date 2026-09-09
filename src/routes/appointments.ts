/**
 * Rotas de agendamentos — CRUD + criação com validação de overlap.
 *
 * A exclusão de overlap é garantida DUAS vezes (defesa em profundidade):
 * 1. overlaps() do domínio valida ANTES do insert → 409 amigável
 * 2. exclusion constraint no banco (última linha de defesa, concorrência)
 *    → erro SQL 23P01 mapeado para 409
 */

import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import { appointments, clients, services, users } from "../db/schema.js";
import { overlaps } from "../domain/booking.js";
import type { AppEnv } from "../types.js";

async function requireUser(db: Db, firebaseUid: string) {
	const rows = await db
		.select()
		.from(users)
		.where(eq(users.firebaseUid, firebaseUid))
		.limit(1);
	return rows[0] ?? null;
}

function pgErrorCode(err: unknown): string | undefined {
	// Drizzle embrulha erros do postgres-js em DrizzleQueryError (cause original)
	const e = err as { code?: string; cause?: { code?: string } };
	return e.code ?? e.cause?.code;
}

type CreateBody = {
	clientId?: unknown;
	serviceId?: unknown;
	userId?: unknown;
	startsAt?: unknown;
	endsAt?: unknown;
};

function parseDate(v: unknown): Date | null {
	if (typeof v !== "string") return null;
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? null : d;
}

function isUuid(v: unknown): v is string {
	return (
		typeof v === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
	);
}

export function appointmentRoutes(databaseUrl: string) {
	const db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	// GET /appointments?from=ISO&to=ISO — agenda do período (default: hoje)
	routes.get("/", async (c) => {
		const authUser = c.get("authUser");
		const user = await requireUser(db, authUser.uid);
		/* v8 ignore next 3 -- inatingível: paywall middleware retorna 404 antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);

		const now = new Date();
		const from = parseDate(c.req.query("from")) ?? new Date(now.toDateString());
		const to =
			parseDate(c.req.query("to")) ??
			new Date(from.getTime() + 24 * 3600 * 1000);

		const rows = await db
			.select({
				id: appointments.id,
				startsAt: appointments.startsAt,
				endsAt: appointments.endsAt,
				status: appointments.status,
				source: appointments.source,
				clientId: appointments.clientId,
				serviceId: appointments.serviceId,
				userId: appointments.userId,
				client_name: clients.name,
				client_phone: clients.phoneE164,
				service_name: services.name,
				service_duration_min: services.durationMin,
				service_price_cents: services.priceCents,
			})
			.from(appointments)
			.leftJoin(clients, eq(appointments.clientId, clients.id))
			.leftJoin(services, eq(appointments.serviceId, services.id))
			.where(
				and(
					eq(appointments.businessId, user.businessId),
					gte(appointments.startsAt, from),
					lte(appointments.startsAt, to),
				),
			)
			.orderBy(asc(appointments.startsAt));

		return c.json({ appointments: rows });
	});

	// POST /appointments — cria com checagem de overlap
	routes.post("/", async (c) => {
		const authUser = c.get("authUser");
		const user = await requireUser(db, authUser.uid);
		/* v8 ignore next 3 -- inatingível: paywall middleware retorna 404 antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);

		const body = (await c.req.json().catch(() => null)) as CreateBody | null;
		if (!body) return c.json({ error: "body inválido (JSON esperado)" }, 400);

		const { clientId, serviceId, startsAt, endsAt } = body;
		const professionalId = isUuid(body.userId) ? body.userId : user.id;

		if (!isUuid(clientId) || !isUuid(serviceId)) {
			return c.json(
				{ error: "clientId e serviceId são obrigatórios (uuid)" },
				400,
			);
		}
		const start = parseDate(startsAt);
		const end = parseDate(endsAt);
		if (!start || !end) {
			return c.json(
				{ error: "startsAt/endsAt inválidos (ISO 8601 esperado)" },
				400,
			);
		}

		// Defesa 1: validação de domínio (mensagem amigável).
		// Só agendamentos ATIVOS ocupam slot — cancelado/noshow libera
		// (mesma semântica da WHERE clause da exclusion constraint).
		const existing = await db
			.select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
			.from(appointments)
			.where(
				and(
					eq(appointments.businessId, user.businessId),
					eq(appointments.userId, professionalId),
					// drizzle: inArray para status ativos
					sql`${appointments.status} IN ('pending', 'confirmed')`,
				),
			);
		for (const row of existing) {
			// startsAt < endsAt é garantido pelo banco (CHECK + tstzrange)
			if (overlaps(row.startsAt, row.endsAt, start, end)) {
				return c.json(
					{
						error: "conflito de horário",
						hint: "Este profissional já tem um agendamento nesse intervalo.",
						conflictWith: { startsAt: row.startsAt, endsAt: row.endsAt },
					},
					409,
				);
			}
		}

		try {
			const [created] = await db
				.insert(appointments)
				.values({
					businessId: user.businessId,
					clientId,
					serviceId,
					userId: professionalId,
					startsAt: start,
					endsAt: end,
					status: "confirmed",
					source: "app",
					createdByUserId: user.id,
				})
				.returning();
			return c.json({ appointment: created }, 201);
		} catch (err) {
			// Defesa 2: exclusion constraint (corrida de concorrência)
			const code = pgErrorCode(err);
			if (code === "23P01") {
				return c.json(
					{
						error: "conflito de horário",
						hint: "Horário acabou de ser ocupado.",
					},
					409,
				);
			}
			if (code === "23503") {
				return c.json({ error: "cliente ou serviço inexistente" }, 400);
			}
			throw err;
		}
	});

	// PATCH /appointments/:id — cancelar (soft: status) ou remarcar
	routes.patch("/:id", async (c) => {
		const authUser = c.get("authUser");
		const user = await requireUser(db, authUser.uid);
		/* v8 ignore next 3 -- inatingível: paywall middleware retorna 404 antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);

		const id = c.req.param("id");
		if (!isUuid(id)) return c.json({ error: "id inválido" }, 400);

		const body = (await c.req.json().catch(() => null)) as {
			status?: unknown;
			startsAt?: unknown;
			endsAt?: unknown;
			canceledReason?: unknown;
		} | null;
		if (!body) return c.json({ error: "body inválido" }, 400);

		const [current] = await db
			.select()
			.from(appointments)
			.where(
				and(
					eq(appointments.id, id),
					eq(appointments.businessId, user.businessId),
				),
			)
			.limit(1);
		if (!current) return c.json({ error: "agendamento não encontrado" }, 404);

		const patch: Partial<typeof appointments.$inferInsert> = {};

		if (body.status !== undefined) {
			if (
				body.status !== "canceled" &&
				body.status !== "noshow" &&
				body.status !== "done" &&
				body.status !== "confirmed"
			) {
				return c.json({ error: "status inválido" }, 400);
			}
			patch.status = body.status;
			if (body.status === "canceled") {
				patch.canceledReason =
					typeof body.canceledReason === "string" ? body.canceledReason : null;
			}
		}

		if (body.startsAt !== undefined || body.endsAt !== undefined) {
			const start = parseDate(body.startsAt) ?? current.startsAt;
			const end = parseDate(body.endsAt) ?? current.endsAt;
			if (start >= end)
				return c.json({ error: "startsAt deve ser antes de endsAt" }, 400);

			// valida overlap contra os OUTROS agendamentos ATIVOS do mesmo profissional
			const others = await db
				.select({
					id: appointments.id,
					startsAt: appointments.startsAt,
					endsAt: appointments.endsAt,
				})
				.from(appointments)
				.where(
					and(
						eq(appointments.businessId, user.businessId),
						eq(appointments.userId, current.userId),
						sql`${appointments.status} IN ('pending', 'confirmed')`,
					),
				);
			for (const row of others) {
				if (row.id === id) continue;
				// startsAt < endsAt é garantido pelo banco (CHECK + tstzrange)
				if (overlaps(row.startsAt, row.endsAt, start, end)) {
					return c.json(
						{ error: "conflito de horário", hint: "Novo horário ocupado." },
						409,
					);
				}
			}
			patch.startsAt = start;
			patch.endsAt = end;
		}

		if (Object.keys(patch).length === 0) {
			return c.json(
				{ error: "nada para atualizar (status/startsAt/endsAt)" },
				400,
			);
		}

		try {
			const [updated] = await db
				.update(appointments)
				.set(patch)
				.where(eq(appointments.id, id))
				.returning();
			return c.json({ appointment: updated });
		} catch (err) {
			if (pgErrorCode(err) === "23P01") {
				return c.json(
					{ error: "conflito de horário", hint: "Horário ocupado." },
					409,
				);
			}
			throw err;
		}
	});

	return routes;
}
