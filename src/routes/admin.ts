/**
 * Rotas /v1/admin/* — Admin MVP (SPEC-admin RF-A1/A2/A3/A6).
 *
 * Todas exigem Firebase token válido + requirePlatformAdminFactory (montado
 * em app.ts ANTES destas rotas). O paywall comercial não se aplica aqui.
 *
 * - GET  /tenants            lista paginada, busca, filtro de status
 * - GET  /tenants/:id        detalhe seguro
 * - PATCH /tenants/:id/status  suspender / reativar (+ auditoria mesma tx)
 * - GET  /tenants/:id/billing  409 billing_not_configured (frente Asaas)
 * - GET  /audit-log          auditoria paginada, filtros, máx 90 dias
 */

import { and, asc, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import { adminAuditLog, businesses, users } from "../db/schema.js";
import { clientIp, type PlatformAdmin } from "../middleware/admin-guard.js";
import type { AppEnv } from "../types.js";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TENANT_STATUSES = [
	"active",
	"suspended",
	"trial",
	"active_subscription",
	"past_due",
	"canceled",
] as const;
export type TenantStatusFilter = (typeof TENANT_STATUSES)[number];

/** Insere linha de auditoria dentro da transação da mutação. Falha aborta. */
export async function appendAdminAudit(
	tx: Db | Parameters<Parameters<Db["transaction"]>[0]>[0],
	input: {
		whoUserId: string;
		what: string;
		targetType: string;
		targetId: string;
		metadata?: Record<string, unknown>;
		ip: string;
	},
): Promise<void> {
	await tx.insert(adminAuditLog).values({
		whoUserId: input.whoUserId,
		what: input.what,
		targetType: input.targetType,
		targetId: input.targetId,
		metadata: input.metadata ?? {},
		ip: input.ip,
	});
}

function parsePagination(c: {
	req: { query: (k: string) => string | undefined };
}): { page: number; pageSize: number } | null {
	const pageRaw = c.req.query("page") ?? "1";
	const sizeRaw = c.req.query("page_size") ?? "25";
	const page = Number(pageRaw);
	const pageSize = Number(sizeRaw);
	if (!Number.isInteger(page) || page < 1) return null;
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
		return null;
	}
	return { page, pageSize };
}

/** Lista de owner por business (role owner; legado sem owner → email null). */
function ownersSubquery() {
	return db
		.select({
			businessId: users.businessId,
			email: sql<
				string | null
			>`max(case when ${users.role} = 'owner' then ${users.email} end)`.as(
				"email",
			),
		})
		.from(users)
		.groupBy(users.businessId)
		.as("owners");
}

let db: Db;

export function adminRoutes(databaseUrl: string) {
	db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	// GET /tenants — lista paginada com busca e filtro.
	routes.get("/tenants", async (c) => {
		const pg = parsePagination(c);
		if (!pg)
			return c.json({ error: "Parâmetros de paginação inválidos." }, 400);
		const q = c.req.query("q")?.trim() ?? "";
		if (q.length > 120) {
			return c.json({ error: "Busca excede 120 caracteres." }, 400);
		}
		const status = c.req.query("status");
		if (
			status !== undefined &&
			!(TENANT_STATUSES as readonly string[]).includes(status)
		) {
			return c.json({ error: "status inválido." }, 400);
		}

		const owners = ownersSubquery();
		const conds = [eq(businesses.isPlatformInternal, false)];
		if (q) {
			conds.push(
				or(ilike(businesses.name, `%${q}%`), ilike(owners.email, `%${q}%`))!,
			);
		}
		if (status === "active") conds.push(sql`${businesses.suspendedAt} is null`);
		if (status === "suspended") {
			conds.push(sql`${businesses.suspendedAt} is not null`);
		}
		if (status === "trial") {
			conds.push(eq(businesses.subscriptionStatus, "trial"));
		}
		if (status === "active_subscription") {
			conds.push(eq(businesses.subscriptionStatus, "active"));
		}
		if (status === "past_due") {
			conds.push(eq(businesses.subscriptionStatus, "past_due"));
		}
		if (status === "canceled") {
			conds.push(eq(businesses.subscriptionStatus, "canceled"));
		}
		const where = and(...conds);

		const items = await db
			.select({
				id: businesses.id,
				name: businesses.name,
				slug: businesses.slug,
				ownerEmail: owners.email,
				subscriptionStatus: businesses.subscriptionStatus,
				trialEndsAt: businesses.trialEndsAt,
				suspendedAt: businesses.suspendedAt,
				createdAt: businesses.createdAt,
			})
			.from(businesses)
			.leftJoin(owners, eq(owners.businessId, businesses.id))
			.where(where)
			.orderBy(desc(businesses.createdAt), desc(businesses.id))
			.limit(pg.pageSize)
			.offset((pg.page - 1) * pg.pageSize);

		const totalRows = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(businesses)
			.leftJoin(owners, eq(owners.businessId, businesses.id))
			.where(where);
		const total = totalRows[0]?.count ?? 0;

		return c.json({
			items: items.map((t) => ({
				id: t.id,
				name: t.name,
				slug: t.slug,
				owner_email: t.ownerEmail,
				subscription_status: t.subscriptionStatus,
				trial_ends_at: t.trialEndsAt?.toISOString() ?? null,
				suspended_at: t.suspendedAt?.toISOString() ?? null,
				created_at: t.createdAt.toISOString(),
			})),
			page: pg.page,
			page_size: pg.pageSize,
			total,
		});
	});

	// GET /tenants/:id — detalhe seguro (404 se interno/inexistente).
	routes.get("/tenants/:id", async (c) => {
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) return c.json({ error: "id inválido." }, 400);
		const owners = ownersSubquery();
		const rows = await db
			.select({
				id: businesses.id,
				name: businesses.name,
				slug: businesses.slug,
				ownerEmail: owners.email,
				subscriptionStatus: businesses.subscriptionStatus,
				trialEndsAt: businesses.trialEndsAt,
				suspendedAt: businesses.suspendedAt,
				suspensionReason: businesses.suspensionReason,
				createdAt: businesses.createdAt,
			})
			.from(businesses)
			.leftJoin(owners, eq(owners.businessId, businesses.id))
			.where(
				and(eq(businesses.id, id), eq(businesses.isPlatformInternal, false)),
			)
			.limit(1);
		const t = rows[0];
		if (!t) return c.json({ error: "tenant não encontrado." }, 404);
		return c.json({
			id: t.id,
			name: t.name,
			slug: t.slug,
			owner_email: t.ownerEmail,
			subscription_status: t.subscriptionStatus,
			trial_ends_at: t.trialEndsAt?.toISOString() ?? null,
			suspended_at: t.suspendedAt?.toISOString() ?? null,
			suspension_reason: t.suspensionReason,
			created_at: t.createdAt.toISOString(),
		});
	});

	// PATCH /tenants/:id/status — suspender/reativar + auditoria na mesma tx.
	routes.patch("/tenants/:id/status", async (c) => {
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) return c.json({ error: "id inválido." }, 400);
		const body = await c.req
			.json()
			.catch(() => null as unknown as Record<string, unknown>);
		if (!body || typeof body !== "object") {
			return c.json({ error: "Body inválido." }, 400);
		}
		const status = body.status;
		if (status !== "suspended" && status !== "active") {
			return c.json({ error: "status deve ser 'suspended' ou 'active'." }, 400);
		}
		const reason =
			typeof body.reason === "string" ? body.reason.trim() : undefined;
		if (
			status === "suspended" &&
			(!reason || reason.length < 1 || reason.length > 500)
		) {
			return c.json(
				{ error: "reason é obrigatório (1..500) para suspender." },
				400,
			);
		}

		const admin: PlatformAdmin = c.get("platformAdmin");
		const ip = clientIp(c);

		const result = await db.transaction(async (tx) => {
			const rows = await tx
				.select({
					id: businesses.id,
					suspendedAt: businesses.suspendedAt,
				})
				.from(businesses)
				.where(
					and(eq(businesses.id, id), eq(businesses.isPlatformInternal, false)),
				)
				.limit(1)
				.for("update");
			const tenant = rows[0];
			if (!tenant) return { code: 404 as const };

			const suspending = status === "suspended";
			if (suspending === (tenant.suspendedAt !== null)) {
				return { code: 409 as const };
			}

			if (suspending) {
				await tx
					.update(businesses)
					.set({
						suspendedAt: new Date(),
						suspendedByUserId: admin.userId,
						suspensionReason: reason,
					})
					.where(eq(businesses.id, id));
			} else {
				await tx
					.update(businesses)
					.set({
						suspendedAt: null,
						suspendedByUserId: null,
						suspensionReason: null,
					})
					.where(eq(businesses.id, id));
			}

			await appendAdminAudit(tx, {
				whoUserId: admin.userId,
				what: suspending ? "tenant.suspended" : "tenant.reactivated",
				targetType: "tenant",
				targetId: id,
				metadata: {
					previous: suspending ? "active" : "suspended",
					new: suspending ? "suspended" : "active",
					...(suspending ? { reason } : {}),
				},
				ip,
			});
			return { code: 200 as const };
		});

		if (result.code === 404) {
			return c.json({ error: "tenant não encontrado." }, 404);
		}
		if (result.code === 409) {
			return c.json({ error: "tenant já está nesse estado." }, 409);
		}

		// Estado final seguro (re-read pós-commit).
		const finalRows = await db
			.select({
				id: businesses.id,
				suspendedAt: businesses.suspendedAt,
				suspensionReason: businesses.suspensionReason,
			})
			.from(businesses)
			.where(eq(businesses.id, id))
			.limit(1);
		const t = finalRows[0];
		if (!t) return c.json({ error: "tenant não encontrado." }, 404);
		return c.json({
			id: t.id,
			suspended_at: t.suspendedAt?.toISOString() ?? null,
			suspension_reason: t.suspensionReason,
		});
	});

	// GET /tenants/:id/billing — contrato defensivo (frente Asaas).
	// Sem projeção billing persistida disponível: 409 explícito, sem dados falsos.
	routes.get("/tenants/:id/billing", async (c) => {
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) return c.json({ error: "id inválido." }, 400);
		const rows = await db
			.select({ id: businesses.id })
			.from(businesses)
			.where(
				and(eq(businesses.id, id), eq(businesses.isPlatformInternal, false)),
			)
			.limit(1);
		if (!rows[0]) return c.json({ error: "tenant não encontrado." }, 404);
		return c.json({ error: "billing_not_configured" }, 409);
	});

	// GET /audit-log — leitura paginada; máx 90 dias por consulta.
	routes.get("/audit-log", async (c) => {
		const pg = parsePagination(c);
		if (!pg)
			return c.json({ error: "Parâmetros de paginação inválidos." }, 400);
		const tenantId = c.req.query("tenant_id");
		if (tenantId !== undefined && !UUID_RE.test(tenantId)) {
			return c.json({ error: "tenant_id inválido." }, 400);
		}
		const whoUserId = c.req.query("who_user_id");
		if (whoUserId !== undefined && !UUID_RE.test(whoUserId)) {
			return c.json({ error: "who_user_id inválido." }, 400);
		}
		const what = c.req.query("what");
		if (what !== undefined && what.length > 80) {
			return c.json({ error: "what excede 80 caracteres." }, 400);
		}
		const fromRaw = c.req.query("from");
		const toRaw = c.req.query("to");
		let from: Date | undefined;
		let to: Date | undefined;
		if (fromRaw !== undefined) {
			from = new Date(fromRaw);
			if (Number.isNaN(from.getTime())) {
				return c.json({ error: "from inválido (ISO-8601)." }, 400);
			}
		}
		if (toRaw !== undefined) {
			to = new Date(toRaw);
			if (Number.isNaN(to.getTime())) {
				return c.json({ error: "to inválido (ISO-8601)." }, 400);
			}
		}
		if (from && to && from > to) {
			return c.json({ error: "from deve ser <= to." }, 400);
		}
		if (from && to && to.getTime() - from.getTime() > 90 * 24 * 3600 * 1000) {
			return c.json({ error: "Período máximo de 90 dias." }, 400);
		}

		const conds = [];
		if (tenantId) conds.push(eq(adminAuditLog.targetId, tenantId));
		if (whoUserId) conds.push(eq(adminAuditLog.whoUserId, whoUserId));
		if (what) conds.push(eq(adminAuditLog.what, what));
		if (from) conds.push(gte(adminAuditLog.occurredAt, from));
		if (to) conds.push(lte(adminAuditLog.occurredAt, to));
		const where = conds.length > 0 ? and(...conds) : undefined;

		const items = await db
			.select({
				id: adminAuditLog.id,
				what: adminAuditLog.what,
				targetType: adminAuditLog.targetType,
				targetId: adminAuditLog.targetId,
				metadata: adminAuditLog.metadata,
				occurredAt: adminAuditLog.occurredAt,
				ip: adminAuditLog.ip,
				whoName: users.name,
				whoEmail: users.email,
			})
			.from(adminAuditLog)
			.leftJoin(users, eq(users.id, adminAuditLog.whoUserId))
			.where(where)
			.orderBy(desc(adminAuditLog.occurredAt), desc(adminAuditLog.id))
			.limit(pg.pageSize)
			.offset((pg.page - 1) * pg.pageSize);

		const totalRows = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(adminAuditLog)
			.where(where);
		const total = totalRows[0]?.count ?? 0;

		return c.json({
			items: items.map((a) => ({
				id: a.id,
				who: { name: a.whoName, email: a.whoEmail },
				what: a.what,
				target: { type: a.targetType, id: a.targetId },
				metadata: a.metadata,
				occurred_at: a.occurredAt.toISOString(),
				ip: a.ip,
			})),
			page: pg.page,
			page_size: pg.pageSize,
			total,
		});
	});

	return routes;
}

// asc importado para uso futuro em ordenações estáveis de teste.
void asc;
