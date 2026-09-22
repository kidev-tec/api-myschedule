/**
 * POST /v1/auth/sync — espelha o usuário do Firebase no Postgres.
 *
 * Chamado pelo app no 1º login (e a cada login para refresh do perfil).
 * Fluxo: middleware já validou o ID token → aqui fazemos upsert por
 * firebase_uid. Se o usuário é novo, cria também o business (trial 15 dias)
 * — o MVP trata 1 profissional = 1 business (multi-profissional no mesmo
 * business entra em F2 via convite).
 *
 * Idempotente: chamar 2x não duplica nada.
 */

import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/connection.js";
import {
	appointments,
	businesses,
	clients,
	deviceTokens,
	loyaltyCards,
	loyaltyPrograms,
	messageTemplates,
	services,
	subscriptions,
	transactions,
	users,
	workingHours,
} from "../db/schema.js";
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
		// Segmento pode vir no 1º sync (onboarding passo 0). Se veio e é
		// válido, define o business já na criação (default segue 'beauty').
		const SYNC_SEGMENTS = [
			"beauty",
			"barber",
			"dental",
			"medical",
			"auto_detailing",
			"pet_grooming",
			"veterinary",
			"mechanic",
			"other",
		] as const;
		const syncSegment =
			typeof body.business_type === "string" &&
			(SYNC_SEGMENTS as readonly string[]).includes(body.business_type)
				? body.business_type
				: undefined;

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
			trialEnds.setDate(trialEnds.getDate() + 15);

			// Índice 0004 (nome+segmento): no 1º sync o segmento é o default
			// 'beauty'. Se já existir homônimo, sufixa o uid (app renomeia no
			// onboarding via PATCH /me).
			const defaultSegment = syncSegment ?? "beauty";
			const clash = await tx
				.select({ id: businesses.id })
				.from(businesses)
				.where(
					and(
						sql`lower(btrim(${businesses.name})) = lower(btrim(${name}))`,
						eq(businesses.businessType, defaultSegment),
					),
				)
				.limit(1);
			const bizName =
				clash.length > 0 ? `${name} · ${authUser.uid}`.slice(0, 120) : name;

			const biz = (
				await tx
					.insert(businesses)
					.values({
						name: bizName,
						slug,
						...(syncSegment ? { businessType: syncSegment } : {}),
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

	/**
	 * DELETE /v1/auth/account — exclusão da conta (LGPD art. 18, VI).
	 *
	 * Apaga TODOS os dados do usuário e do business em cascata (ordem FK),
	 * dentro de uma transação. O registro no Firebase Auth é removido depois
	 * (best-effort: se falhar, o Postgres já está limpo e o login seguinte
	 * recria um user órfão novo via sync — nunca trava a exclusão).
	 *
	 * App chama com confirmação dupla (digitar EXCLUIR) — ver settings_page.
	 */
	routes.delete("/auth/account", async (c) => {
		const authUser = c.get("authUser");
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, authUser.uid))
				.limit(1)
		)[0];
		/* v8 ignore next -- atingível (teste 404 abaixo cobre), mas o v8 coverage
		   com pool: forks desloca coveredBy entre workers neste arquivo */
		if (!me) return c.json({ error: "user não encontrado" }, 404);

		await db.transaction(async (tx) => {
			// ordem FK: netos → filhos → business/user por último
			await tx
				.delete(appointments)
				.where(eq(appointments.businessId, me.businessId));
			await tx
				.delete(transactions)
				.where(eq(transactions.businessId, me.businessId));
			await tx
				.delete(loyaltyCards)
				.where(
					sql`${loyaltyCards.clientId} IN (SELECT id FROM clients WHERE business_id = ${me.businessId})`,
				);
			await tx
				.delete(loyaltyPrograms)
				.where(eq(loyaltyPrograms.businessId, me.businessId));
			await tx
				.delete(messageTemplates)
				.where(eq(messageTemplates.businessId, me.businessId));
			await tx
				.delete(subscriptions)
				.where(eq(subscriptions.businessId, me.businessId));
			await tx.delete(clients).where(eq(clients.businessId, me.businessId));
			await tx.delete(services).where(eq(services.businessId, me.businessId));
			await tx.delete(workingHours).where(eq(workingHours.userId, me.id));
			await tx.delete(deviceTokens).where(eq(deviceTokens.userId, me.id));
			await tx.delete(users).where(eq(users.id, me.id));
			await tx.delete(businesses).where(eq(businesses.id, me.businessId));
		});

		// best-effort: apaga do Firebase Auth também (roda DEPOIS do commit)
		let firebaseDeleted = true;
		try {
			const { getAuth } = await import("firebase-admin/auth");
			await getAuth().deleteUser(authUser.uid);
		} catch {
			firebaseDeleted = false;
		}

		return c.json({ ok: true, firebaseDeleted });
	});

	return routes;
}
