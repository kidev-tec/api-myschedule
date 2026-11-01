/**
 * Rotas de clientes — GET lista, POST cria, GET/PATCH/DELETE por id (soft-delete).
 *
 * Contrato do app (clients_page, client_form_page, booking_wizard):
 * - GET  /clients → [{ id, name, phone_e164, email }]
 * - POST /clients { name, phone_e164, email?, birthday?, notes?, cpf?, nickname?,
 *   referral_source?, marketing_consent?, address? } → cria
 * - GET  /clients/:id
 * - PATCH /clients/:id { name, phone_e164, email?, birthday?, notes? } → edita
 *   (dedupe: telefone que já existe em OUTRO cliente do negócio → 409;
 *    deleted_at NÃO é editável via PATCH)
 * - DELETE /clients/:id → soft-delete (deleted_at); ?cancel_future=1 cancela
 *   junto os agendamentos futuros. Histórico e agendamentos ficam no banco.
 * - GET  /clients?archived=1 → só os arquivados
 * - GET  /clients/:id/upcoming → agendamentos futuros ativos (aviso antes de
 *   arquivar)
 * - POST /clients/:id/restore → reativa um arquivado
 * - GET  /clients/ranking?period=all|365|30 → quem mais foi atendido
 * - Celular repetido (só dígitos, com/sem 55) no POST/PATCH/restore → 409
 *   { error, existing, archived } — o app oferece usar/editar/reativar.
 * - Arquivado continua acessível por id e no histórico (não some do app).
 */

import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import { appointments, clients, services, users } from "../db/schema.js";
import { parseClientProfile } from "../domain/client-profile.js";
import { mirrorToCalendar } from "../domain/gcal-mirror.js";
import { phoneMatchKeys } from "../domain/phone-br.js";
import { notifyWaitlistOpening } from "../services/waitlist-notify.js";
import type { AppEnv } from "../types.js";

function serialize(r: typeof clients.$inferSelect) {
	return {
		id: r.id,
		name: r.name,
		phone_e164: r.phoneE164,
		email: r.email,
		birthday: r.birthday,
		notes: r.notes,
		cpf: r.cpf,
		nickname: r.nickname,
		referral_source: r.referralSource,
		marketing_consent: r.marketingConsent,
		// 0023: 'public_link' = se cadastrou sozinho no agendamento online
		origin: r.origin,
		// arquivado ("excluído"): some da lista e de novos agendamentos, mas o
		// histórico e os agendamentos continuam
		archived: r.deletedAt !== null,
		address: {
			zip: r.addressZip,
			street: r.addressStreet,
			number: r.addressNumber,
			complement: r.addressComplement,
			district: r.addressDistrict,
			city: r.addressCity,
			state: r.addressState,
		},
	};
}

/** Texto opcional: aparado; vazio/ausente/não-texto vira null. */
function optionalText(v: unknown): string | null {
	return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function clientsRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	/**
	 * Cliente do negócio que já usa esse celular (compara só os dígitos, com e
	 * sem o 55). Ativos primeiro. `exceptId` ignora o próprio (edição).
	 */
	async function phoneOwner(
		businessId: string,
		phone: string,
		opts: { exceptId?: string; activeOnly?: boolean } = {},
	) {
		const [row] = await db
			.select()
			.from(clients)
			.where(
				and(
					eq(clients.businessId, businessId),
					inArray(
						sql`regexp_replace(${clients.phoneE164}, '[^0-9]', '', 'g')`,
						phoneMatchKeys(phone),
					),
					...(opts.exceptId ? [ne(clients.id, opts.exceptId)] : []),
					...(opts.activeOnly ? [isNull(clients.deletedAt)] : []),
				),
			)
			.orderBy(sql`${clients.deletedAt} IS NOT NULL`, asc(clients.createdAt))
			.limit(1);
		return row;
	}

	/** 409 "esse celular já é de Fulano" com o cliente pro app oferecer ação. */
	function duplicate(row: typeof clients.$inferSelect) {
		const archived = row.deletedAt !== null;
		return {
			error: `Esse celular já é de ${row.name}${archived ? " (cliente arquivado)" : ""}`,
			existing: serialize(row),
			archived,
		};
	}

	routes.get("/clients", async (c) => {
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, c.get("authUser").uid))
				.limit(1)
		)[0];
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const archived = c.req.query("archived") === "1";
		const rows = await db
			.select()
			.from(clients)
			.where(
				and(
					eq(clients.businessId, me.businessId),
					archived ? isNotNull(clients.deletedAt) : isNull(clients.deletedAt),
					// cliente técnico do bloqueio (sem telefone) nunca aparece
					ne(clients.phoneE164, ""),
				),
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
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);

		const body = (await c.req.json().catch(() => null)) as {
			name?: unknown;
			phone_e164?: unknown;
			email?: unknown;
			birthday?: unknown;
			notes?: unknown;
		} | null;
		const profile = parseClientProfile(body ?? {});
		if ("error" in profile) return c.json({ error: profile.error }, 400);
		const name = typeof body?.name === "string" ? body.name.trim() : "";
		const phone =
			typeof body?.phone_e164 === "string" ? body.phone_e164.trim() : "";
		const email = optionalText(body?.email);
		// aniversário e informações do cliente já na criação (antes eram
		// ignorados no POST e só gravavam numa edição posterior)
		const birthday = optionalText(body?.birthday);
		const notes = optionalText(body?.notes);
		if (name.length < 1 || phone.length < 10) {
			return c.json(
				{ error: "name obrigatório e phone_e164 válido (>=10 dígitos)" },
				400,
			);
		}
		const owner = await phoneOwner(me.businessId, phone);
		if (owner) return c.json(duplicate(owner), 409);
		const created = (
			await db
				.insert(clients)
				.values({
					businessId: me.businessId,
					name,
					phoneE164: phone,
					email,
					birthday,
					notes,
					...profile.value,
				})
				.returning()
		)[0];
		/* v8 ignore next -- defensivo: INSERT..RETURNING nunca é vazio no Postgres */
		if (!created) return c.json({ error: "falha ao criar cliente" }, 500);
		return c.json(serialize(created), 201);
	});

	/**
	 * Ranking de clientes (quem mais foi atendido). Conta como atendimento:
	 * "concluído" + pendente/confirmado cujo horário já passou (quase ninguém
	 * marca concluído). Fora: cancelado, falta e bloqueio de horário.
	 * ?period=all|365|30 (dias). Arquivados entram (o histórico conta).
	 * Registrada ANTES de /clients/:id ("ranking" não é um id).
	 */
	routes.get("/clients/ranking", async (c) => {
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, c.get("authUser").uid))
				.limit(1)
		)[0];
		/* v8 ignore next -- inatingível: auth retorna antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const period = c.req.query("period") ?? "all";
		const days = period === "30" ? 30 : period === "365" ? 365 : null;
		if (period !== "all" && days === null) {
			return c.json({ error: "period inválido (all, 365 ou 30)" }, 400);
		}
		const limitRaw = Number(c.req.query("limit") ?? 50);
		const limit =
			Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 50;
		const now = new Date();
		const rows = await db
			.select({
				id: clients.id,
				name: clients.name,
				phone: clients.phoneE164,
				deletedAt: clients.deletedAt,
				visits: sql<number>`count(*)::int`,
				lastVisit: sql<Date>`max(${appointments.startsAt})`,
				totalCents: sql<number>`coalesce(sum(${services.priceCents}), 0)::int`,
			})
			.from(appointments)
			.innerJoin(clients, eq(clients.id, appointments.clientId))
			.innerJoin(services, eq(services.id, appointments.serviceId))
			.where(
				and(
					eq(appointments.businessId, me.businessId),
					ne(appointments.source, "block"),
					ne(clients.phoneE164, ""),
					or(
						eq(appointments.status, "done"),
						and(
							inArray(appointments.status, ["pending", "confirmed"]),
							lt(appointments.startsAt, now),
						),
					),
					...(days
						? [
								gt(
									appointments.startsAt,
									new Date(now.getTime() - days * 86_400_000),
								),
							]
						: []),
				),
			)
			.groupBy(clients.id)
			.orderBy(
				sql`count(*) desc`,
				sql`coalesce(sum(${services.priceCents}), 0) desc`,
				sql`max(${appointments.startsAt}) desc`,
			)
			.limit(limit);
		return c.json({
			period,
			ranking: rows.map((r, i) => ({
				position: i + 1,
				client_id: r.id,
				name: r.name,
				phone_e164: r.phone,
				archived: r.deletedAt !== null,
				visits: r.visits,
				last_visit: new Date(r.lastVisit).toISOString(),
				total_cents: r.totalCents,
			})),
		});
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
		// arquivado também abre (detalhes/observações na agenda)
		const rows = await db
			.select()
			.from(clients)
			.where(and(eq(clients.id, id), eq(clients.businessId, me.businessId)))
			.limit(1);
		const row = rows[0];
		if (!row) return c.json({ error: "cliente não encontrado" }, 404);
		return c.json(serialize(row));
	});

	/**
	 * F4 — histórico do cliente: GET /clients/:id/history
	 * Últimos 50 appointments do cliente + agregados (total, última visita).
	 * Só appointments do próprio business. Serve pro prestador ver
	 * "esse cliente veio 12x, sempre corta degradê" na hora de agendar.
	 */
	routes.get("/clients/:id/history", async (c) => {
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
		if (!UUID_RE.test(id)) return c.json({ error: "id inválido" }, 400);

		// cliente tem que ser do business do prestador (arquivado também:
		// o histórico nunca se perde)
		const client = (
			await db
				.select({ id: clients.id })
				.from(clients)
				.where(and(eq(clients.id, id), eq(clients.businessId, me.businessId)))
				.limit(1)
		)[0];
		if (!client) return c.json({ error: "cliente não encontrado" }, 404);

		const agg = (
			await db
				.select({
					total: sql<number>`count(*)::int`,
					canceled: sql<number>`count(*) filter (where ${appointments.status} = 'canceled')::int`,
					noshow: sql<number>`count(*) filter (where ${appointments.status} = 'noshow')::int`,
					lastVisit: sql<Date | null>`max(${appointments.startsAt})`,
				})
				.from(appointments)
				.where(
					and(
						eq(appointments.clientId, id),
						eq(appointments.businessId, me.businessId),
					),
				)
		)[0]!;

		const recent = await db
			.select({
				id: appointments.id,
				startsAt: appointments.startsAt,
				endsAt: appointments.endsAt,
				status: appointments.status,
				serviceName: services.name,
				priceCents: services.priceCents,
			})
			.from(appointments)
			.innerJoin(services, eq(services.id, appointments.serviceId))
			.where(
				and(
					eq(appointments.clientId, id),
					eq(appointments.businessId, me.businessId),
				),
			)
			.orderBy(sql`${appointments.startsAt} desc`)
			.limit(50);

		return c.json({
			total: agg.total,
			canceled: agg.canceled,
			noshow: agg.noshow,
			last_visit: agg.lastVisit,
			recent: recent.map((r) => ({
				id: r.id,
				starts_at: r.startsAt.toISOString(),
				ends_at: r.endsAt.toISOString(),
				status: r.status,
				service_name: r.serviceName,
				price_cents: r.priceCents,
			})),
		});
	});

	routes.patch("/clients/:id", async (c) => {
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, c.get("authUser").uid))
				.limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) return c.json({ error: "id inválido" }, 400);

		const body = (await c.req.json().catch(() => null)) as {
			name?: unknown;
			phone_e164?: unknown;
			email?: unknown;
			birthday?: unknown;
			notes?: unknown;
			deleted_at?: unknown;
		} | null;
		const name = typeof body?.name === "string" ? body.name.trim() : "";
		const phone =
			typeof body?.phone_e164 === "string" ? body.phone_e164.trim() : "";
		if (name.length < 1 || phone.length < 10) {
			return c.json(
				{ error: "name obrigatório e phone_e164 válido (>=10 dígitos)" },
				400,
			);
		}
		// deleted_at nunca editável via PATCH (soft-delete só via DELETE)
		if (body?.deleted_at !== undefined) {
			return c.json({ error: "deleted_at não é editável" }, 400);
		}
		const email = optionalText(body?.email);
		const birthday = optionalText(body?.birthday);
		const notes = optionalText(body?.notes);
		const profile = parseClientProfile({ ...body });
		if ("error" in profile) return c.json({ error: profile.error }, 400);

		// Dedupe: celular único no negócio (só dígitos, com/sem 55; inclui
		// arquivados — aí o app oferece reativar em vez de duplicar)
		const owner = await phoneOwner(me.businessId, phone, { exceptId: id });
		if (owner) return c.json(duplicate(owner), 409);

		const updated = await db
			.update(clients)
			.set({
				name,
				phoneE164: phone,
				email,
				birthday,
				notes,
				...profile.value,
			})
			.where(
				and(
					eq(clients.id, id),
					eq(clients.businessId, me.businessId),
					isNull(clients.deletedAt),
				),
			)
			.returning();
		const upd = updated[0];
		if (!upd) return c.json({ error: "cliente não encontrado" }, 404);
		return c.json(serialize(upd));
	});

	/** Agendamentos futuros ativos do cliente (aviso antes de arquivar). */
	async function upcomingOf(
		businessId: string,
		clientId: string,
		// dentro de transação, usa a conexão dela (senha do pool não dá deadlock)
		q: Pick<Db, "select"> = db,
	) {
		return q
			.select({
				id: appointments.id,
				startsAt: appointments.startsAt,
				serviceName: services.name,
			})
			.from(appointments)
			.innerJoin(services, eq(services.id, appointments.serviceId))
			.where(
				and(
					eq(appointments.businessId, businessId),
					eq(appointments.clientId, clientId),
					sql`${appointments.status} IN ('pending', 'confirmed')`,
					gt(appointments.startsAt, new Date()),
				),
			)
			.orderBy(asc(appointments.startsAt));
	}

	routes.get("/clients/:id/upcoming", async (c) => {
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
		if (!UUID_RE.test(id)) return c.json({ error: "id inválido" }, 400);
		const rows = await upcomingOf(me.businessId, id);
		return c.json({
			upcoming: rows.map((r) => ({
				id: r.id,
				starts_at: r.startsAt.toISOString(),
				service_name: r.serviceName,
			})),
		});
	});

	routes.delete("/clients/:id", async (c) => {
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, c.get("authUser").uid))
				.limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) return c.json({ error: "id inválido" }, 400);
		const cancelFuture = c.req.query("cancel_future") === "1";
		const result = await db.transaction(async (tx) => {
			const [upd] = await tx
				.update(clients)
				.set({ deletedAt: new Date() })
				.where(and(eq(clients.id, id), eq(clients.businessId, me.businessId)))
				.returning();
			if (!upd) return null;
			let canceled: { id: string; startsAt: Date }[] = [];
			if (cancelFuture) {
				const future = await upcomingOf(me.businessId, id, tx);
				if (future.length > 0) {
					await tx
						.update(appointments)
						.set({
							status: "canceled",
							canceledAt: new Date(),
							canceledReason: "cliente arquivado",
						})
						.where(
							inArray(
								appointments.id,
								future.map((f) => f.id),
							),
						);
					canceled = future;
				}
			}
			return { upd, canceled };
		});
		if (!result) return c.json({ error: "cliente não encontrado" }, 404);
		// espelho do Google Calendar remove os cancelados (best-effort)
		for (const appt of result.canceled) {
			mirrorToCalendar(databaseUrl, appt.id).catch(
				/* v8 ignore next -- best-effort: falha do Calendar não falha a rota */
				(e) => console.error("[gcal] espelho falhou:", e),
			);
		}
		// horários liberados: avisa quem está na lista de espera desses dias
		if (result.canceled.length > 0) {
			await notifyWaitlistOpening(
				databaseUrl,
				{ userId: me.id, businessId: me.businessId },
				result.canceled.map((a) => a.startsAt),
			);
		}
		return c.json({
			...serialize(result.upd),
			canceled_appointments: result.canceled.length,
		});
	});

	routes.post("/clients/:id/restore", async (c) => {
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, c.get("authUser").uid))
				.limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) return c.json({ error: "id inválido" }, 400);
		const [row] = await db
			.select()
			.from(clients)
			.where(
				and(
					eq(clients.id, id),
					eq(clients.businessId, me.businessId),
					isNotNull(clients.deletedAt),
					ne(clients.phoneE164, ""),
				),
			)
			.limit(1);
		if (!row) return c.json({ error: "cliente arquivado não encontrado" }, 404);
		// outro cliente ATIVO com o mesmo celular → não duplica
		const owner = await phoneOwner(me.businessId, row.phoneE164, {
			exceptId: id,
			activeOnly: true,
		});
		if (owner) return c.json(duplicate(owner), 409);
		const [upd] = await db
			.update(clients)
			.set({ deletedAt: null })
			.where(eq(clients.id, id))
			.returning();
		/* v8 ignore next -- UPDATE..RETURNING na linha validada acima */
		if (!upd) return c.json({ error: "cliente não encontrado" }, 404);
		return c.json(serialize(upd));
	});

	return routes;
}
