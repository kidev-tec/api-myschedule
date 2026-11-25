/**
 * Guards do Admin MVP (SPEC-admin RF-A1/A2/A3/A6).
 *
 * - requirePlatformAdminFactory: autoriza somente users.role='platform_admin'.
 *   403 genérico — nunca vaza role/tenant. 401 tratado pelo middleware Firebase
 *   global (este guard só roda depois dele).
 * - requireTenantActiveFactory: bloqueia (403) qualquer chamada de tenant com
 *   businesses.suspended_at NOT NULL. Usuário sem espelho no Postgres passa
 *   (permite POST /v1/auth/sync criar 1º acesso); nunca roda em /v1/admin/*.
 *
 * A allowlist ADMIN_EMAILS é UX do frontend — a autoridade aqui é o banco.
 */

import { eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { type Db, getDb } from "../db/connection.js";
import { businesses, users } from "../db/schema.js";
import type { AppEnv } from "../types.js";

export type PlatformAdmin = {
	userId: string;
	email: string | undefined;
	name: string | undefined;
};

declare module "hono" {
	interface ContextVariableMap {
		platformAdmin: PlatformAdmin;
	}
}

function clientIp(c: Context): string {
	// SPEC decisões #7: primeiro endereço de x-forwarded-for; fallback 'local'.
	// Caddy/proxy deve sobrescrever o header do cliente — sem esse hardening o
	// IP é indicativo, não forense.
	const fwd = c.req.header("x-forwarded-for");
	if (fwd) {
		const first = fwd.split(",")[0]?.trim();
		if (first) return first;
	}
	return "local";
}

export { clientIp };

export function requirePlatformAdminFactory(
	databaseUrl: string,
): (c: Context<AppEnv>, next: Next) => Promise<Response | void> {
	const db = getDb(databaseUrl);
	return async (c, next) => {
		const authUser = c.get("authUser");
		const rows = await db
			.select({ id: users.id, role: users.role })
			.from(users)
			.where(eq(users.firebaseUid, authUser.uid))
			.limit(1);
		const user = rows[0];
		if (!user || user.role !== "platform_admin") {
			// 403 genérico: mesma resposta para inexistente e sem permissão.
			return c.json({ error: "Acesso restrito." }, 403);
		}
		c.set("platformAdmin", {
			userId: user.id,
			email: authUser.email,
			name: authUser.name,
		});
		await next();
	};
}

export function requireTenantActiveFactory(
	databaseUrl: string,
): (c: Context<AppEnv>, next: Next) => Promise<Response | void> {
	const db = getDb(databaseUrl);
	return async (c, next) => {
		const authUser = c.get("authUser");
		// Rotas públicas (sem auth): authUser ausente → não há espelho p/ checar.
		if (!authUser) return next();
		const rows = await db
			.select({ suspendedAt: businesses.suspendedAt })
			.from(users)
			.innerJoin(businesses, eq(users.businessId, businesses.id))
			.where(eq(users.firebaseUid, authUser.uid))
			.limit(1);
		const row = rows[0];
		// Sem espelho no Postgres: deixa passar (auth/sync cria 1º acesso).
		if (!row) return next();
		if (row.suspendedAt) {
			return c.json({ error: "tenant suspenso" }, 403);
		}
		await next();
	};
}
