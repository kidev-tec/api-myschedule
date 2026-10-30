/**
 * Rotas de agendamentos — CRUD + criação com validação de overlap.
 *
 * A exclusão de overlap é garantida DUAS vezes (defesa em profundidade):
 * 1. overlaps() do domínio valida ANTES do insert → 409 amigável
 * 2. exclusion constraint no banco (última linha de defesa, concorrência)
 *    → erro SQL 23P01 mapeado para 409
 */

import { and, asc, eq, gt, gte, isNotNull, lt, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import {
	appointments,
	businesses,
	clients,
	services,
	timeOffs,
	users,
	waitlist,
	workingHours,
} from "../db/schema.js";
import { overlaps } from "../domain/booking.js";
import { confirmationToken } from "../domain/confirmation-token.js";
import {
	isValidBufferMin,
	isValidDurationMin,
	isWithinWorkingHours,
	occupiedEnd,
	resolveEffectiveInterval,
	type WorkingHour,
} from "../domain/duration.js";
import { mirrorToCalendar } from "../domain/gcal-mirror.js";
import { startsOnOrBeforeToday } from "../domain/schedule-day.js";
import { resolveCombo } from "../domain/service-kits.js";
import { notify } from "../services/notify.js";
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
	// duração flexível (SPEC v1.0.0): override por agendamento em minutos.
	duration_min?: unknown;
	// 0022: vários serviços (2+) num horário só; 1 item = serviceId
	serviceIds?: unknown;
	// 0020: folga após o atendimento; omitido = padrão do negócio.
	buffer_min?: unknown;
	// RF-A: "block" cria bloqueio de horário (compromisso externo do prestador).
	// canceledReason é reaproveitado como MOTIVO do bloqueio (campo já existia).
	source?: unknown;
	canceledReason?: unknown;
	notes?: unknown;
};

const NOTES_MAX = 1000;

const DURATION_ERROR = "Duração inválida (5 a 480 minutos, de 5 em 5)";
const BUFFER_ERROR =
	"Intervalo entre atendimentos inválido (0 a 120 minutos, de 5 em 5)";

/**
 * Observações do prestador: texto opcional, aparado; vazio vira null.
 * `undefined` = campo não enviado. Retorna `{ error }` se inválido.
 */
function parseNotes(
	v: unknown,
): { value: string | null | undefined } | { error: string } {
	if (v === undefined) return { value: undefined };
	if (v !== null && typeof v !== "string") {
		return { error: "Observações devem ser texto" };
	}
	const t = (v ?? "").trim();
	if (t.length > NOTES_MAX) {
		return { error: `Observações: no máximo ${NOTES_MAX} caracteres` };
	}
	return { value: t === "" ? null : t };
}

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

// RF-A: par técnico do bloqueio de horário. O schema exige cliente+serviço
// em todo appointment; o bloqueio usa um par por business criado JÁ oculto:
// serviço arquivado (fora da lista, do wizard e do link público) e cliente
// removido (fora da lista de clientes). A agenda ainda mostra os nomes via
// join. Antes o app tentava criar esse par e falhava (nunca funcionou).
export const BLOCK_SERVICE_NAME = "Bloqueio";
export const BLOCK_CLIENT_NAME = "— bloqueio —";

async function blockPair(
	db: Db,
	businessId: string,
): Promise<{ clientId: string; serviceId: string }> {
	let [svc] = await db
		.select({ id: services.id })
		.from(services)
		.where(
			and(
				eq(services.businessId, businessId),
				eq(services.name, BLOCK_SERVICE_NAME),
				isNotNull(services.archivedAt),
			),
		)
		.limit(1);
	if (!svc) {
		[svc] = await db
			.insert(services)
			.values({
				businessId,
				name: BLOCK_SERVICE_NAME,
				durationMin: 60,
				priceCents: 0,
				archivedAt: new Date(),
			})
			.returning({ id: services.id });
	}
	let [cli] = await db
		.select({ id: clients.id })
		.from(clients)
		.where(
			and(
				eq(clients.businessId, businessId),
				eq(clients.name, BLOCK_CLIENT_NAME),
				isNotNull(clients.deletedAt),
			),
		)
		.limit(1);
	if (!cli) {
		// telefone vazio: o link público (que casa cliente por telefone com
		// 10+ dígitos) nunca reaproveita este registro
		[cli] = await db
			.insert(clients)
			.values({
				businessId,
				name: BLOCK_CLIENT_NAME,
				phoneE164: "",
				deletedAt: new Date(),
			})
			.returning({ id: clients.id });
	}
	/* v8 ignore next -- INSERT..RETURNING nunca é vazio no Postgres */
	if (!svc || !cli) throw new Error("falha ao preparar bloqueio");
	return { clientId: cli.id, serviceId: svc.id };
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
				bufferMin: appointments.bufferMin,
				status: appointments.status,
				source: appointments.source,
				// RF-A02: motivo do bloqueio (canceledReason reaproveitado)
				canceledReason: appointments.canceledReason,
				notes: appointments.notes,
				clientId: appointments.clientId,
				serviceId: appointments.serviceId,
				userId: appointments.userId,
				client_name: clients.name,
				// como o cliente prefere ser chamado (mensagens de WhatsApp)
				client_nickname: clients.nickname,
				// 0023: 'public_link' = cliente se cadastrou no agendamento online
				client_origin: clients.origin,
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

		const { startsAt, endsAt } = body;
		const professionalId = isUuid(body.userId) ? body.userId : user.id;

		// RF-A: source opcional no POST. "block" = bloqueio de horário.
		// Qualquer outro valor (além de omitir) é rejeitado — default é "app".
		const isBlock = body.source !== undefined;
		if (isBlock && body.source !== "block") {
			return c.json({ error: "source inválida (use 'block')" }, 400);
		}

		let clientId: string;
		let serviceId: string;
		if (isBlock) {
			// Bloqueio não tem cliente/serviço de verdade: a API usa um par
			// técnico oculto (ignora o que o app mandar).
			({ clientId, serviceId } = await blockPair(db, user.businessId));
		} else if (Array.isArray(body.serviceIds) && body.serviceIds.length > 1) {
			// 0022: vários serviços num horário só → kit oculto "A + B"
			if (!isUuid(body.clientId)) {
				return c.json({ error: "clientId é obrigatório (uuid)" }, 400);
			}
			clientId = body.clientId;
			const combo = await resolveCombo(db, user.businessId, body.serviceIds);
			if ("error" in combo) return c.json({ error: combo.error }, 400);
			serviceId = combo.serviceId;
		} else {
			// serviceIds com 1 item = serviceId
			const oneId = Array.isArray(body.serviceIds)
				? body.serviceIds[0]
				: body.serviceId;
			if (!isUuid(body.clientId) || !isUuid(oneId)) {
				return c.json(
					{ error: "clientId e serviceId são obrigatórios (uuid)" },
					400,
				);
			}
			clientId = body.clientId;
			serviceId = oneId;
			// Serviço excluído (arquivado) não aceita NOVOS agendamentos; os já
			// feitos continuam com ele (histórico) e podem ser remarcados (PATCH).
			const [svc] = await db
				.select({ archivedAt: services.archivedAt })
				.from(services)
				.where(
					and(
						eq(services.id, serviceId),
						eq(services.businessId, user.businessId),
					),
				)
				.limit(1);
			if (svc?.archivedAt) {
				return c.json(
					{
						error:
							"Esse serviço foi excluído e não aceita novos agendamentos. Escolha outro serviço.",
					},
					400,
				);
			}
		}

		const start = parseDate(startsAt);
		if (!start) {
			return c.json(
				{ error: "startsAt/endsAt inválidos (ISO 8601 esperado)" },
				400,
			);
		}

		// duração flexível (SPEC v1.0.0): duration_min preferred; endsAt legado.
		const hasDuration = body.duration_min !== undefined;
		const hasEndsAt = body.endsAt !== undefined;
		let end: Date | null;
		if (hasDuration) {
			if (!isValidDurationMin(body.duration_min)) {
				return c.json(
					{
						error: DURATION_ERROR,
					},
					400,
				);
			}
			const resolved = resolveEffectiveInterval(
				start,
				body.duration_min,
				hasEndsAt ? (parseDate(body.endsAt) ?? undefined) : undefined,
			);
			if (!resolved) {
				return c.json(
					{
						error:
							"duration_min e endsAt divergem (endsAt deve ser startsAt + duration_min)",
					},
					400,
				);
			}
			end = resolved.end;
		} else if (hasEndsAt) {
			end = parseDate(body.endsAt);
			if (!end) {
				return c.json(
					{ error: "startsAt/endsAt inválidos (ISO 8601 esperado)" },
					400,
				);
			}
		} else {
			return c.json({ error: "informe duration_min (ou endsAt legado)" }, 400);
		}
		if (start >= end) {
			return c.json({ error: "startsAt deve ser antes de endsAt" }, 400);
		}

		// Compatibilidade: legado startsAt+endsAt mantém contrato anterior.
		// Novo duration_min exige jornada integral (SPEC v1.0.0).
		if (hasDuration) {
			const [bizRow] = await db
				.select({ timezone: businesses.timezone })
				.from(businesses)
				.where(eq(businesses.id, user.businessId))
				.limit(1);
			const hours = await db
				.select({
					weekday: workingHours.weekday,
					startTime: workingHours.startTime,
					endTime: workingHours.endTime,
				})
				.from(workingHours)
				.where(eq(workingHours.userId, professionalId));
			if (
				!bizRow ||
				!isWithinWorkingHours(
					start,
					end,
					hours as WorkingHour[],
					bizRow.timezone,
				)
			) {
				return c.json(
					{
						error: "horário fora da jornada de atendimento deste profissional",
					},
					400,
				);
			}
		}

		// 0020: folga após o atendimento. Omitida = padrão do negócio;
		// bloqueio de horário não tem folga.
		let bufferMin: number;
		if (body.buffer_min !== undefined) {
			if (!isValidBufferMin(body.buffer_min)) {
				return c.json({ error: BUFFER_ERROR }, 400);
			}
			bufferMin = body.buffer_min;
		} else if (isBlock) {
			bufferMin = 0;
		} else {
			const [biz] = await db
				.select({ bufferMin: businesses.bufferMin })
				.from(businesses)
				.where(eq(businesses.id, user.businessId))
				.limit(1);
			/* v8 ignore next -- business do usuário sempre existe (FK) */
			bufferMin = biz?.bufferMin ?? 0;
		}
		const busyUntil = occupiedEnd(end, bufferMin);

		// Defesa 1: validação de domínio (mensagem amigável).
		// Só agendamentos ATIVOS ocupam slot — cancelado/noshow libera
		// (mesma semântica da WHERE clause da exclusion constraint).
		// Cada lado ocupa [início, fim + folga).
		const existing = await db
			.select({
				startsAt: appointments.startsAt,
				endsAt: appointments.endsAt,
				bufferMin: appointments.bufferMin,
			})
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
			if (
				overlaps(
					row.startsAt,
					occupiedEnd(row.endsAt, row.bufferMin),
					start,
					busyUntil,
				)
			) {
				return c.json(
					{
						error: "conflito de horário",
						hint:
							bufferMin > 0 || row.bufferMin > 0
								? "Este profissional já tem um agendamento nesse intervalo (considerando o intervalo entre atendimentos)."
								: "Este profissional já tem um agendamento nesse intervalo.",
						conflictWith: { startsAt: row.startsAt, endsAt: row.endsAt },
					},
					409,
				);
			}
		}
		// F3: bloqueios de agenda (time-offs) também conflitam
		const timeOffRows = await db
			.select({ startsAt: timeOffs.startsAt, endsAt: timeOffs.endsAt })
			.from(timeOffs)
			.where(
				and(
					eq(timeOffs.userId, professionalId),
					lt(timeOffs.startsAt, end),
					gt(timeOffs.endsAt, start),
				),
			);
		if (timeOffRows.length > 0) {
			return c.json(
				{
					error: "conflito de horário",
					hint: "Este horário está bloqueado na agenda do profissional.",
					conflictWith: {
						startsAt: timeOffRows[0]!.startsAt,
						endsAt: timeOffRows[0]!.endsAt,
					},
				},
				409,
			);
		}

		const notes = parseNotes(body.notes);
		if ("error" in notes) return c.json({ error: notes.error }, 400);

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
					bufferMin,
					status: "confirmed",
					source: isBlock ? "block" : "app",
					// motivo do bloqueio (RF-A02) — campo reaproveitado
					canceledReason:
						isBlock && typeof body.canceledReason === "string"
							? body.canceledReason
							: null,
					notes: notes.value ?? null,
					createdByUserId: user.id,
				})
				.returning();
			return c.json({ appointment: created }, 201);
		} catch (err) {
			// Defesa 2: exclusion constraint (corrida de concorrência).
			// 40P01 = deadlock de duas transações no mesmo slot → também 409.
			const code = pgErrorCode(err);
			if (code === "23P01" || code === "40P01") {
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

	// RF-B01: link de confirmação do cliente (usado pelo app pra montar
	// a mensagem do WhatsApp). Requer auth — é o prestador pedindo.
	routes.get("/:id/confirm-link", async (c) => {
		const authUser = c.get("authUser");
		const user = await requireUser(db, authUser.uid);
		/* v8 ignore next 3 -- inatingível: paywall middleware retorna 404 antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);

		const id = c.req.param("id");
		if (!isUuid(id)) return c.json({ error: "id inválido" }, 400);

		const [appt] = await db
			.select({ startsAt: appointments.startsAt })
			.from(appointments)
			.where(
				and(
					eq(appointments.id, id),
					eq(appointments.businessId, user.businessId),
				),
			)
			.limit(1);
		if (!appt) return c.json({ error: "agendamento não encontrado" }, 404);

		// slug do business (necessário pro link público)
		const [biz] = await db
			.select({ slug: businesses.slug })
			.from(businesses)
			.where(eq(businesses.id, user.businessId))
			.limit(1);
		/* v8 ignore next -- user.businessId sempre aponta pra business existente */
		if (!biz) return c.json({ error: "business não encontrado" }, 404);

		const token = confirmationToken(id, appt.startsAt);
		// split sempre retorna ≥1 elemento; ?? só satisfaz o typechecker
		const base = c.req.url.split("/v1/")[0] as string;
		const link = `${base}/p/${biz.slug}/confirm/${id}?token=${token}`;
		return c.json({ link });
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
			duration_min?: unknown;
			buffer_min?: unknown;
			canceledReason?: unknown;
			notes?: unknown;
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

		const notes = parseNotes(body.notes);
		if ("error" in notes) return c.json({ error: notes.error }, 400);
		if (notes.value !== undefined) patch.notes = notes.value;

		if (body.status !== undefined) {
			if (
				body.status !== "canceled" &&
				body.status !== "noshow" &&
				body.status !== "done" &&
				body.status !== "confirmed"
			) {
				return c.json({ error: "status inválido" }, 400);
			}
			// Regras de status x horário (revisão 28/10 da decisão 21/09):
			// - cancelar: a qualquer momento;
			// - concluir / não compareceu: só até HOJE no fuso do negócio;
			// - confirmar: só horário futuro.
			// Mudar startsAt na MESMA request reabre o horário — nesse caso a
			// mudança de status é legítima (remarcação + confirmação).
			const rechedules =
				body.startsAt !== undefined ||
				body.endsAt !== undefined ||
				body.duration_min !== undefined ||
				body.buffer_min !== undefined;
			if (!rechedules) {
				if (body.status === "done" || body.status === "noshow") {
					const [biz] = await db
						.select({ timezone: businesses.timezone })
						.from(businesses)
						.where(eq(businesses.id, user.businessId))
						.limit(1);
					/* v8 ignore next -- business do usuário sempre existe (FK) */
					const tz = biz?.timezone ?? "America/Sao_Paulo";
					if (!startsOnOrBeforeToday(current.startsAt, tz)) {
						return c.json(
							{
								error:
									"Esse dia ainda não chegou — só é possível concluir ou marcar falta a partir do dia do agendamento",
							},
							400,
						);
					}
				} else if (
					body.status === "confirmed" &&
					current.startsAt.getTime() <= Date.now()
				) {
					return c.json(
						{
							error:
								"Este horário já passou — não é possível alterar o agendamento",
						},
						400,
					);
				}
			}
			patch.status = body.status;
			if (body.status === "canceled") {
				patch.canceledAt = new Date();
				patch.canceledReason =
					typeof body.canceledReason === "string" ? body.canceledReason : null;
			}
		}

		if (
			body.startsAt !== undefined ||
			body.endsAt !== undefined ||
			body.duration_min !== undefined ||
			body.buffer_min !== undefined
		) {
			const start = parseDate(body.startsAt) ?? current.startsAt;
			// B5 (UX): mudou só o início → preserva a DURAÇÃO original
			// (leigo não calcula fim; "mover" o agendamento inteiro).
			let end: Date;
			if (body.duration_min !== undefined) {
				if (!isValidDurationMin(body.duration_min)) {
					return c.json(
						{
							error: DURATION_ERROR,
						},
						400,
					);
				}
				const resolved = resolveEffectiveInterval(
					start,
					body.duration_min,
					body.endsAt !== undefined
						? (parseDate(body.endsAt) ?? undefined)
						: undefined,
				);
				if (!resolved) {
					return c.json(
						{
							error:
								"duration_min e endsAt divergem (endsAt deve ser startsAt + duration_min)",
						},
						400,
					);
				}
				end = resolved.end;
			} else if (body.endsAt !== undefined) {
				/* v8 ignore next -- parseDate inválida cai em 400 antes (startsAt>=end) */
				end = parseDate(body.endsAt) ?? current.endsAt;
			} else {
				// B5 (UX): mudou só o início → preserva a DURAÇÃO original
				// (leigo não calcula fim; "mover" o agendamento inteiro).
				const durMs = current.endsAt.getTime() - current.startsAt.getTime();
				end = new Date(start.getTime() + durMs);
			}
			if (start >= end)
				return c.json({ error: "startsAt deve ser antes de endsAt" }, 400);

			// Compatibilidade: PATCH legado não ganha nova restrição.
			// duration_min ativa validação integral de jornada (SPEC v1.0.0).
			if (body.duration_min !== undefined) {
				const [bizRow] = await db
					.select({ timezone: businesses.timezone })
					.from(businesses)
					.where(eq(businesses.id, user.businessId))
					.limit(1);
				const hours = await db
					.select({
						weekday: workingHours.weekday,
						startTime: workingHours.startTime,
						endTime: workingHours.endTime,
					})
					.from(workingHours)
					.where(eq(workingHours.userId, current.userId));
				if (
					!bizRow ||
					!isWithinWorkingHours(
						start,
						end,
						hours as WorkingHour[],
						bizRow.timezone,
					)
				) {
					return c.json(
						{
							error:
								"horário fora da jornada de atendimento deste profissional",
						},
						400,
					);
				}
			}

			// 0020: folga omitida = mantém a do agendamento atual.
			let bufferMin = current.bufferMin;
			if (body.buffer_min !== undefined) {
				if (!isValidBufferMin(body.buffer_min)) {
					return c.json({ error: BUFFER_ERROR }, 400);
				}
				bufferMin = body.buffer_min;
			}
			const busyUntil = occupiedEnd(end, bufferMin);

			// valida overlap contra os OUTROS agendamentos ATIVOS do mesmo profissional
			const others = await db
				.select({
					id: appointments.id,
					startsAt: appointments.startsAt,
					endsAt: appointments.endsAt,
					bufferMin: appointments.bufferMin,
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
				if (
					overlaps(
						row.startsAt,
						occupiedEnd(row.endsAt, row.bufferMin),
						start,
						busyUntil,
					)
				) {
					return c.json(
						{ error: "conflito de horário", hint: "Novo horário ocupado." },
						409,
					);
				}
			}
			patch.startsAt = start;
			patch.endsAt = end;
			patch.bufferMin = bufferMin;
		}

		// BARRA B5: remarcar mantém HISTÓRICO — a linha original é cancelada
		// (canceled_at + reason "remarcado") e uma NOVA linha ativa é criada
		// com as datas novas. Status puro (done/noshow/confirm/cancel sem
		// mudança de data) continua sendo update in-place.
		const isReschedule =
			(patch.startsAt !== undefined || patch.endsAt !== undefined) &&
			patch.status === undefined;

		if (Object.keys(patch).length === 0) {
			return c.json(
				{ error: "nada para atualizar (status/startsAt/endsAt/notes)" },
				400,
			);
		}

		try {
			if (isReschedule) {
				const nova = await db.transaction(async (tx) => {
					// 1. cancela a linha original (histórico preservado)
					const [antiga] = await tx
						.update(appointments)
						.set({
							status: "canceled",
							canceledAt: new Date(),
							canceledReason: "remarcado",
						})
						.where(eq(appointments.id, id))
						.returning();
					/* v8 ignore next 2 -- UPDATE..RETURNING na linha já validada acima */
					if (!antiga) throw new Error("agendamento desapareceu");
					// 2. cria a nova linha ativa com as datas novas.
					// Herda gcalEventId pra o espelho ATUALIZAR o mesmo evento
					// do Calendar em vez de criar um novo (RF-08).
					const [criada] = await tx
						.insert(appointments)
						.values({
							businessId: antiga.businessId,
							clientId: antiga.clientId,
							serviceId: antiga.serviceId,
							userId: antiga.userId,
							// isReschedule: patch.startsAt/endsAt já contêm as datas
							// resolvidas (nova ou herdada do bloco de datas acima).
							startsAt: patch.startsAt as Date,
							endsAt: patch.endsAt as Date,
							bufferMin: patch.bufferMin as number,
							status: "confirmed",
							source: antiga.source,
							gcalEventId: antiga.gcalEventId,
							// observações acompanham a remarcação (ou as novas enviadas)
							notes: notes.value !== undefined ? notes.value : antiga.notes,
							createdByUserId: user.id,
						})
						.returning();
					/* v8 ignore next -- INSERT..RETURNING nunca é vazio no Postgres */
					if (!criada) throw new Error("falha ao criar nova linha");
					return criada;
				});
				mirrorToCalendar(databaseUrl, nova.id).catch((e) =>
					console.error("[gcal] espelho falhou:", e),
				);
				return c.json({ appointment: nova, rescheduled: true });
			}

			const [updated] = await db
				.update(appointments)
				.set(patch)
				.where(eq(appointments.id, id))
				.returning();

			// RF-08: espelha no Google Calendar do business (fire-and-forget:
			// falha de calendar não falha o PATCH). mirrorToCalendar decide
			// sozinho: cria (confirmado), atualiza (remarcado), remove (cancelado).
			/* v8 ignore next 3 -- defensivo: UPDATE..RETURNING nunca é vazio */
			if (updated) {
				mirrorToCalendar(databaseUrl, updated.id).catch((e) =>
					console.error("[gcal] espelho falhou:", e),
				);
				// F5: cancelou → conta pra lista de espera do dia quantos
				// interessados existem (push best-effort pro prestador avisar)
				if (patch.status === "canceled") {
					const dayStr = updated.startsAt.toISOString().slice(0, 10);
					const waiting = await db
						.select({ n: sql<number>`count(*)::int` })
						.from(waitlist)
						.where(
							and(
								eq(waitlist.businessId, user.businessId),
								sql`${waitlist.desiredDate}::date = ${dayStr}::date`,
								eq(waitlist.status, "waiting"),
							),
						);
					const n = waiting[0]?.n ?? 0;
					if (n > 0) {
						void notify(databaseUrl, {
							userId: user.id,
							type: "waitlist",
							title: "Vaga abriu — lista de espera",
							body: `${n} cliente${n > 1 ? "s" : ""} na espera para esse dia. Abra a lista de espera para avisar.`,
							data: { date: dayStr },
						});
					}
				}
			}

			return c.json({ appointment: updated });
		} catch (err) {
			// 23P01 = exclusion constraint; 40P01 = deadlock de duas transações
			// concorrendo pro mesmo slot (ambas → 409 pro cliente tentar de novo)
			const code = pgErrorCode(err);
			if (code === "23P01" || code === "40P01") {
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
