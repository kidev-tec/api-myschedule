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
import {
  appointments,
  businesses,
  clients,
  services,
  users,
} from "../db/schema.js";
import { overlaps } from "../domain/booking.js";
import { confirmationToken } from "../domain/confirmation-token.js";
import { mirrorToCalendar } from "../domain/gcal-mirror.js";
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
  // RF-A: "block" cria bloqueio de horário (compromisso externo do prestador).
  // canceledReason é reaproveitado como MOTIVO do bloqueio (campo já existia).
  source?: unknown;
  canceledReason?: unknown;
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
        // RF-A02: motivo do bloqueio (canceledReason reaproveitado)
        canceledReason: appointments.canceledReason,
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

    // RF-A: source opcional no POST. "block" = bloqueio de horário.
    // Qualquer outro valor (além de omitir) é rejeitado — default é "app".
    const isBlock = body.source !== undefined;
    if (isBlock && body.source !== "block") {
      return c.json({ error: "source inválida (use 'block')" }, 400);
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
          source: isBlock ? "block" : "app",
          // motivo do bloqueio (RF-A02) — campo reaproveitado
          canceledReason:
            isBlock && typeof body.canceledReason === "string"
              ? body.canceledReason
              : null,
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
        patch.canceledAt = new Date();
        patch.canceledReason =
          typeof body.canceledReason === "string" ? body.canceledReason : null;
      }
    }

    if (body.startsAt !== undefined || body.endsAt !== undefined) {
      const start = parseDate(body.startsAt) ?? current.startsAt;
      // B5 (UX): mudou só o início → preserva a DURAÇÃO original
      // (leigo não calcula fim; "mover" o agendamento inteiro).
      let end: Date;
      if (body.endsAt !== undefined) {
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

    // BARRA B5: remarcar mantém HISTÓRICO — a linha original é cancelada
    // (canceled_at + reason "remarcado") e uma NOVA linha ativa é criada
    // com as datas novas. Status puro (done/noshow/confirm/cancel sem
    // mudança de data) continua sendo update in-place.
    const isReschedule =
      (patch.startsAt !== undefined || patch.endsAt !== undefined) &&
      patch.status === undefined;

    if (Object.keys(patch).length === 0) {
      return c.json(
        { error: "nada para atualizar (status/startsAt/endsAt)" },
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
              status: "confirmed",
              source: antiga.source,
              gcalEventId: antiga.gcalEventId,
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
