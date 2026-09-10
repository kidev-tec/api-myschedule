/**
 * POST /v1/auth/sync — espelha o usuário do Firebase no Postgres.
 *
 * Chamado pelo app no 1º login (e a cada login para refresh do perfil).
 * Fluxo: middleware já validou o ID token → aqui fazemos upsert por
 * firebase_uid. Se o usuário é novo, cria também o business (trial 30 dias)
 * — o MVP trata 1 profissional = 1 business (multi-profissional no mesmo
 * business entra em F2 via convite).
 *
 * Idempotente: chamar 2x não duplica nada.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/connection.js";
import { businesses, users } from "../db/schema.js";
import type { AppEnv } from "../types.js";

export function slugify(name: string): string {
	return (
		name
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/(^-|-$)/g, "")
			.slice(0, 60) || "prof"
	);
}

export function authSyncRoutes(databaseUrl: string) {
	const db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.post("/auth/sync", async (c) => {
		const authUser = c.get("authUser");
		const body = await c.req
			.json()
			.catch(() => ({}) as Record<string, unknown>);
		const name =
			(typeof body.name === "string" && body.name.trim()) ||
			authUser.name ||
			"Profissional";

		// 1) usuário já existe? (upsert por firebase_uid)
		const existing = await db
			.select()
			.from(users)
			.where(eq(users.firebaseUid, authUser.uid))
			.limit(1);

		const user = existing.at(0);
		if (user) {
			// atualiza nome/email se mudaram no Firebase
			await db
				.update(users)
				.set({ name, email: authUser.email ?? user.email })
				.where(eq(users.id, user.id));
			const biz = await db
				.select()
				.from(businesses)
				.where(eq(businesses.id, user.businessId))
				.limit(1);
			return c.json({
				user: { ...user, name, email: authUser.email ?? user.email },
				business: biz[0] ?? null,
			});
		}

		// 2) novo usuário → cria business + user em transação
		const created = await db.transaction(async (tx) => {
			const slugBase = slugify(name);
			// uid completo (128 chars) garante unicidade mesmo com nomes iguais
			const slug = `${slugBase}-${authUser.uid.toLowerCase()}`.slice(0, 80);
			const trialEnds = new Date();
			trialEnds.setDate(trialEnds.getDate() + 30);

			const biz = (
				await tx
					.insert(businesses)
					.values({
						name,
						slug,
						subscriptionStatus: "trial",
						trialEndsAt: trialEnds,
					})
					.returning()
			).at(0);
			/* v8 ignore next -- defensivo: INSERT..RETURNING nunca é vazio no Postgres */
			if (!biz) throw new Error("falha ao criar business");
			const user = (
				await tx
					.insert(users)
					.values({
						businessId: biz.id,
						firebaseUid: authUser.uid,
						email: authUser.email ?? "",
						name,
						role: "owner",
					})
					.returning()
			).at(0);
			return { user, business: biz };
		});

		return c.json(created, 201);
	});

	return routes;
}
