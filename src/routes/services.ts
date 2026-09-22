/**
 * Rotas de serviços + perfil do negócio (onboarding passo 1 e 2).
 *
 * Contrato do app:
 * - GET    /services?q=busca → [{ id, name, duration_min, price_cents, archived_at }]
 *          (só ativos; ?q= filtra por nome, case-insensitive)
 * - POST   /services { name, duration_min, price_cents } → cria
 *          (duration_min: 15..480, múltiplo de 15)
 * - GET    /services/:id → um serviço (ativo)
 * - PATCH  /services/:id { name?, duration_min?, price_cents? } → edita
 * - DELETE /services/:id → ARCHIVE (soft: archived_at). Serviço arquivado
 *          some de novos agendamentos mas permanece no histórico de passados.
 * - PATCH  /me { business_name } → renomeia o business do usuário
 */

import { and, eq, ilike, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import { businesses, services, users, workingHours } from "../db/schema.js";
import type { AppEnv } from "../types.js";

// BARRA B3: duração de serviço 15..480 min, múltiplo de 15.
function durationValida(v: unknown): v is number {
	return (
		typeof v === "number" &&
		Number.isInteger(v) &&
		v >= 15 &&
		v <= 480 &&
		v % 15 === 0
	);
}

function serialize(r: typeof services.$inferSelect) {
	return {
		id: r.id,
		name: r.name,
		duration_min: r.durationMin,
		price_cents: r.priceCents,
		archived_at: r.archivedAt,
	};
}

export function servicesRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.get("/services", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const busca = c.req.query("q")?.trim();
		const rows = await db
			.select()
			.from(services)
			.where(
				and(
					eq(services.businessId, me.businessId),
					isNull(services.archivedAt),
					...(busca ? [ilike(services.name, `%${busca}%`)] : []),
				),
			);
		return c.json(rows.map(serialize));
	});

	routes.post("/services", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);

		const body = (await c.req.json().catch(() => null)) as {
			name?: unknown;
			duration_min?: unknown;
			price_cents?: unknown;
		} | null;
		const name = typeof body?.name === "string" ? body.name.trim() : "";
		const durationMin = body?.duration_min;
		const priceCents = body?.price_cents;
		if (
			name.length < 1 ||
			!durationValida(durationMin) ||
			typeof priceCents !== "number" ||
			priceCents < 0
		) {
			return c.json(
				{
					error:
						"campos obrigatórios: name (str), duration_min (15..480, múltiplo de 15), price_cents (>=0)",
				},
				400,
			);
		}
		const created = (
			await db
				.insert(services)
				.values({
					businessId: me.businessId,
					name,
					durationMin,
					priceCents,
				})
				.returning()
		)[0];
		/* v8 ignore next -- defensivo: INSERT..RETURNING nunca é vazio no Postgres */
		if (!created) return c.json({ error: "falha ao criar serviço" }, 500);
		return c.json(serialize(created), 201);
	});

	routes.get("/services/:id", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!/^[0-9a-f-]{36}$/i.test(id))
			return c.json({ error: "id inválido" }, 400);
		const rows = await db
			.select()
			.from(services)
			.where(
				and(
					eq(services.id, id),
					eq(services.businessId, me.businessId),
					isNull(services.archivedAt),
				),
			)
			.limit(1);
		const row = rows[0];
		if (!row) return c.json({ error: "serviço não encontrado" }, 404);
		return c.json(serialize(row));
	});

	/** PATCH /services/:id — edita nome/duração/preço (disponibilidade = arquivar/recriar). */
	routes.patch("/services/:id", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!/^[0-9a-f-]{36}$/i.test(id))
			return c.json({ error: "id inválido" }, 400);

		const body = (await c.req.json().catch(() => null)) as {
			name?: unknown;
			duration_min?: unknown;
			price_cents?: unknown;
		} | null;

		const updates: {
			name?: string;
			durationMin?: number;
			priceCents?: number;
		} = {};
		if (body?.name !== undefined) {
			if (
				typeof body.name !== "string" ||
				body.name.trim().length < 1 ||
				body.name.trim().length > 120
			)
				return c.json({ error: "name deve ter 1..120 caracteres" }, 400);
			updates.name = body.name.trim();
		}
		if (body?.duration_min !== undefined) {
			if (!durationValida(body.duration_min))
				return c.json(
					{ error: "duration_min deve ser 15..480, múltiplo de 15" },
					400,
				);
			updates.durationMin = body.duration_min;
		}
		if (body?.price_cents !== undefined) {
			if (typeof body.price_cents !== "number" || body.price_cents < 0)
				return c.json({ error: "price_cents deve ser >= 0" }, 400);
			updates.priceCents = body.price_cents;
		}
		if (Object.keys(updates).length === 0)
			return c.json({ error: "nada para atualizar" }, 400);

		const updated = await db
			.update(services)
			.set(updates)
			.where(
				and(
					eq(services.id, id),
					eq(services.businessId, me.businessId),
					isNull(services.archivedAt),
				),
			)
			.returning();
		const upd = updated[0];
		if (!upd) return c.json({ error: "serviço não encontrado" }, 404);
		return c.json(serialize(upd));
	});

	routes.delete("/services/:id", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!/^[0-9a-f-]{36}$/i.test(id))
			return c.json({ error: "id inválido" }, 400);
		const updated = await db
			.update(services)
			.set({ archivedAt: new Date() })
			.where(and(eq(services.id, id), eq(services.businessId, me.businessId)))
			.returning();
		const upd = updated[0];
		if (!upd) return c.json({ error: "serviço não encontrado" }, 404);
		return c.json(serialize(upd));
	});

	return routes;
}

/** GET/PATCH /me — lê/atualiza o business do usuário logado (nome + segmento). */
export function meRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	routes.get("/me", async (c) => {
		const authUser = c.get("authUser");
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, authUser.uid))
				.limit(1)
		)[0];
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const biz = (
			await db
				.select()
				.from(businesses)
				.where(eq(businesses.id, me.businessId))
				.limit(1)
		)[0];
		/* v8 ignore next -- defensivo: user sempre tem business (FK NOT NULL + sync) */
		if (!biz) return c.json({ error: "business não encontrado" }, 404);

		// Onboarding server-side (feedback 22/09): desinstalar o app apaga a
		// flag local — o servidor é a fonte da verdade. Completo = tem ≥1
		// horário de funcionamento E ≥1 serviço ativo (onboarding tem os
		// passos conta+serviços+horários; nome não é sinal, o sync grava o
		// nome real do Firebase desde o início).
		const [hoursRow] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(workingHours)
			.where(eq(workingHours.userId, me.id));
		const [serviceRow] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(services)
			.where(
				and(
					eq(services.businessId, biz.id),
					isNull(services.archivedAt),
				),
			);
		const onboardingComplete =
			(hoursRow?.count ?? 0) > 0 && (serviceRow?.count ?? 0) > 0;

		return c.json({
			id: biz.id,
			name: biz.name,
			slug: biz.slug,
			business_type: biz.businessType,
			timezone: biz.timezone,
			subscription_status: biz.subscriptionStatus,
			trial_ends_at: biz.trialEndsAt,
			logo_url: biz.logoData ? `/v1/businesses/${biz.slug}/logo` : null,
			onboarding_complete: onboardingComplete,
		});
	});

	/**
	 * POST /me/logo — upload multipart (campo "logo", PNG/JPG ≤2MB).
	 * Salva bytea na própria base (Storage REST exige service_role key).
	 */
	routes.post("/me/logo", async (c) => {
		const authUser = c.get("authUser");
		const me = (
			await db
				.select()
				.from(users)
				.where(eq(users.firebaseUid, authUser.uid))
				.limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const biz = (
			await db
				.select()
				.from(businesses)
				.where(eq(businesses.id, me.businessId))
				.limit(1)
		)[0];
		/* v8 ignore next -- defensivo: user sempre tem business */
		if (!biz) return c.json({ error: "business não encontrado" }, 404);

		const MAX_BYTES = 2 * 1024 * 1024;
		const ALLOWED = new Set(["image/png", "image/jpeg"]);
		const mime = c.req.header("content-type")?.split(";")[0] ?? "";
		if (!mime.startsWith("multipart/form-data")) {
			return c.json({ error: "envie a imagem como multipart/form-data" }, 400);
		}
		let file: File | null = null;
		try {
			const form = await c.req.formData();
			const raw = form.get("logo");
			if (raw instanceof File) file = raw;
		} catch {
			return c.json({ error: "não consegui ler o formulário enviado" }, 400);
		}
		if (!(file instanceof File)) {
			return c.json({ error: "campo 'logo' é obrigatório" }, 400);
		}
		if (!ALLOWED.has(file.type)) {
			return c.json({ error: "formato não suportado. Use PNG ou JPG." }, 400);
		}
		if (file.size > MAX_BYTES) {
			return c.json(
				{ error: "a imagem passou de 2MB. Escolha uma menor." },
				400,
			);
		}
		const bytes = Buffer.from(await file.arrayBuffer());
		await db
			.update(businesses)
			.set({ logoData: bytes, logoMime: file.type, logoUpdatedAt: new Date() })
			.where(eq(businesses.id, biz.id));
		return c.json({ logoUrl: `/v1/businesses/${biz.slug}/logo` });
	});

	routes.patch("/me", async (c) => {
		const authUser = c.get("authUser");
		const uid = authUser.uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);

		const body = (await c.req.json().catch(() => null)) as {
			business_name?: unknown;
			business_type?: unknown;
		} | null;
		// PATCH parcial: cada campo é opcional, mas se vier tem que ser válido.
		// (ensureProvisioned do app faz PATCH só com business_type; o
		// onboarding manda nome + segmento.)
		let businessName: string | undefined;
		if (body?.business_name !== undefined) {
			if (typeof body.business_name !== "string") {
				return c.json({ error: "business_name deve ser string" }, 400);
			}
			const trimmed = body.business_name.trim();
			if (trimmed.length < 1 || trimmed.length > 120) {
				return c.json(
					{ error: "business_name deve ter 1..120 caracteres" },
					400,
				);
			}
			businessName = trimmed;
		}
		// PATCH sem nenhum campo conhecido (body null/quebrado/vazio) → 400.
		if (businessName === undefined && body?.business_type === undefined) {
			return c.json({ error: "nada para atualizar" }, 400);
		}
		// Segmento: opcional; se vier, valida contra a whitelist de presets.
		const SEGMENT_IDS = [
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
		let businessType: string | undefined;
		if (body?.business_type !== undefined) {
			if (
				typeof body.business_type !== "string" ||
				!(SEGMENT_IDS as readonly string[]).includes(body.business_type)
			) {
				return c.json({ error: "business_type inválido" }, 400);
			}
			businessType = body.business_type;
		}
		// Unicidade nome+segmento (Rafael 15/09): não pode existir outro
		// business no mesmo segmento com nome idêntico (case-insensitive).
		// Vale também ao mudar só o segmento (nome atual + novo tipo).
		const biz = (
			await db
				.select()
				.from(businesses)
				.where(eq(businesses.id, me.businessId))
				.limit(1)
		).at(0);
		/* v8 ignore next -- defensivo: user sempre tem business (FK NOT NULL + sync) */
		if (!biz) return c.json({ error: "business não encontrado" }, 404);
		// A checagem explícita dá 409 amigável; o índice único do banco
		// (0004) é a defesa final contra corrida.
		const finalName = businessName ?? biz.name;
		const finalSegment = businessType ?? biz.businessType;
		const dup = await db
			.select({ id: businesses.id })
			.from(businesses)
			.where(
				and(
					sql`lower(btrim(${businesses.name})) = lower(btrim(${finalName}))`,
					eq(businesses.businessType, finalSegment),
					sql`${businesses.id} <> ${me.businessId}`,
				),
			)
			.limit(1);
		if (dup.length > 0) {
			return c.json(
				{
					error:
						"Já existe um estabelecimento com esse nome neste segmento. Escolhe outro nome.",
				},
				409,
			);
		}
		await db
			.update(businesses)
			.set({
				...(businessName !== undefined ? { name: businessName } : {}),
				...(businessType ? { businessType } : {}),
			})
			.where(eq(businesses.id, me.businessId));
		return c.json({
			ok: true,
			business_name: businessName ?? null,
			business_type: businessType ?? null,
		});
	});

	return routes;
}
