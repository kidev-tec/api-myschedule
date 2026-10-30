/**
 * Rotas de serviços + perfil do negócio (onboarding passo 1 e 2).
 *
 * Contrato do app:
 * - GET    /services?q=busca → [{ id, name, duration_min, price_cents, archived_at }]
 *          (só ativos; ?q= filtra por nome, case-insensitive)
 * - POST   /services { name, duration_min, price_cents } → cria
 *          (duration_min: 5..480, de 5 em 5 — mesma regra do agendamento)
 * - GET    /services/:id → um serviço (ativo)
 * - PATCH  /services/:id { name?, duration_min?, price_cents? } → edita
 * - DELETE /services/:id → ARCHIVE (soft: archived_at). Serviço arquivado
 *          some de novos agendamentos mas permanece no histórico de passados.
 *          Serviço que está em kit ativo → 409 { kits }; ?kits=archive
 *          arquiva os kits junto.
 * - Kits (0021): POST/PATCH aceitam items: [serviceId, ...] (2..10). Kit vem
 *   com is_kit: true e items: [{ id, name, duration_min, price_cents }].
 * - PATCH  /me { business_name } → renomeia o business do usuário
 */

import { and, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import {
	businesses,
	serviceKitItems,
	services,
	users,
	workingHours,
} from "../db/schema.js";
import { isValidBufferMin, isValidDurationMin } from "../domain/duration.js";
import {
	activeKitsWith,
	type KitItem,
	kitItemsFor,
	validateKitItems,
} from "../domain/service-kits.js";
import type { AppEnv } from "../types.js";

// Duração de serviço: mesma regra da duração por agendamento (5..480, de
// 5 em 5) — antes era múltiplo de 15 e o app aceitava 70 → 400 confuso.
const durationValida = isValidDurationMin;

function serialize(r: typeof services.$inferSelect, items?: KitItem[]) {
	return {
		id: r.id,
		name: r.name,
		duration_min: r.durationMin,
		price_cents: r.priceCents,
		archived_at: r.archivedAt,
		is_kit: r.isKit,
		// só kits têm itens
		/* v8 ignore next -- kitItemsFor devolve lista p/ todo kit */
		...(r.isKit ? { items: items ?? [] } : {}),
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
		const items = await kitItemsFor(
			db,
			rows.filter((r) => r.isKit).map((r) => r.id),
		);
		return c.json(rows.map((r) => serialize(r, items.get(r.id))));
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
			items?: unknown;
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
					error: "Preencha nome, duração (5 a 480 minutos, de 5 em 5) e preço",
				},
				400,
			);
		}
		// Kit (0021): items presentes → combo com esses serviços
		let kitIds: string[] | undefined;
		if (body?.items !== undefined) {
			const v = await validateKitItems(db, me.businessId, body.items);
			if ("error" in v) return c.json({ error: v.error }, 400);
			kitIds = v.ids;
		}
		const created = await db.transaction(async (tx) => {
			const [row] = await tx
				.insert(services)
				.values({
					businessId: me.businessId,
					name,
					durationMin,
					priceCents,
					isKit: kitIds !== undefined,
				})
				.returning();
			/* v8 ignore next -- defensivo: INSERT..RETURNING nunca é vazio no Postgres */
			if (!row) throw new Error("falha ao criar serviço");
			if (kitIds) {
				await tx.insert(serviceKitItems).values(
					kitIds.map((serviceId, position) => ({
						kitId: row.id,
						serviceId,
						position,
					})),
				);
			}
			return row;
		});
		const items = await kitItemsFor(db, created.isKit ? [created.id] : []);
		return c.json(serialize(created, items.get(created.id)), 201);
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
		const items = await kitItemsFor(db, row.isKit ? [row.id] : []);
		return c.json(serialize(row, items.get(row.id)));
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
			items?: unknown;
		} | null;

		const [current] = await db
			.select({ isKit: services.isKit })
			.from(services)
			.where(
				and(
					eq(services.id, id),
					eq(services.businessId, me.businessId),
					isNull(services.archivedAt),
				),
			)
			.limit(1);
		if (!current) return c.json({ error: "serviço não encontrado" }, 404);

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
					{ error: "Duração inválida: de 5 a 480 minutos, de 5 em 5" },
					400,
				);
			updates.durationMin = body.duration_min;
		}
		if (body?.price_cents !== undefined) {
			if (typeof body.price_cents !== "number" || body.price_cents < 0)
				return c.json({ error: "price_cents deve ser >= 0" }, 400);
			updates.priceCents = body.price_cents;
		}
		// Kit: troca a lista de itens inteira
		let kitIds: string[] | undefined;
		if (body?.items !== undefined) {
			if (!current.isKit) {
				return c.json({ error: "Só kits têm serviços incluídos (items)" }, 400);
			}
			const v = await validateKitItems(db, me.businessId, body.items, id);
			if ("error" in v) return c.json({ error: v.error }, 400);
			kitIds = v.ids;
		}
		if (Object.keys(updates).length === 0 && kitIds === undefined)
			return c.json({ error: "nada para atualizar" }, 400);

		const upd = await db.transaction(async (tx) => {
			if (kitIds) {
				await tx.delete(serviceKitItems).where(eq(serviceKitItems.kitId, id));
				await tx.insert(serviceKitItems).values(
					kitIds.map((serviceId, position) => ({
						kitId: id,
						serviceId,
						position,
					})),
				);
			}
			const [row] =
				Object.keys(updates).length > 0
					? await tx
							.update(services)
							.set(updates)
							.where(eq(services.id, id))
							.returning()
					: await tx.select().from(services).where(eq(services.id, id));
			return row as typeof services.$inferSelect;
		});
		const items = await kitItemsFor(db, upd.isKit ? [id] : []);
		return c.json(serialize(upd, items.get(id)));
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
		const [target] = await db
			.select({ id: services.id })
			.from(services)
			.where(and(eq(services.id, id), eq(services.businessId, me.businessId)))
			.limit(1);
		if (!target) return c.json({ error: "serviço não encontrado" }, 404);

		// Serviço dentro de kit ativo: avisa e não exclui — a menos que o
		// prestador peça pra arquivar os kits junto (?kits=archive).
		const kits = await activeKitsWith(db, id);
		if (kits.length > 0 && c.req.query("kits") !== "archive") {
			const nomes = kits.map((k) => `"${k.name}"`).join(", ");
			return c.json(
				{
					error: `Esse serviço faz parte ${kits.length > 1 ? "dos kits" : "do kit"} ${nomes}. Retire-o ${kits.length > 1 ? "dos kits" : "do kit"} antes, ou exclua ${kits.length > 1 ? "os kits" : "o kit"} junto.`,
					kits,
				},
				409,
			);
		}
		const now = new Date();
		const upd = await db.transaction(async (tx) => {
			if (kits.length > 0) {
				await tx
					.update(services)
					.set({ archivedAt: now })
					.where(
						inArray(
							services.id,
							kits.map((k) => k.id),
						),
					);
			}
			const [row] = await tx
				.update(services)
				.set({ archivedAt: now })
				.where(eq(services.id, id))
				.returning();
			return row as typeof services.$inferSelect;
		});
		return c.json({ ...serialize(upd), archived_kits: kits });
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
		// count() sempre devolve 1 linha — [0] garantido pelo Postgres
		const svc = (
			await db
				.select({ n: sql<number>`count(*)::int` })
				.from(services)
				.where(
					and(eq(services.businessId, biz.id), isNull(services.archivedAt)),
				)
		)[0]!;
		const wh = (
			await db
				.select({ n: sql<number>`count(*)::int` })
				.from(workingHours)
				.where(eq(workingHours.userId, me.id))
		)[0]!;
		return c.json({
			id: biz.id,
			name: biz.name,
			slug: biz.slug,
			business_type: biz.businessType,
			timezone: biz.timezone,
			subscription_status: biz.subscriptionStatus,
			trial_ends_at: biz.trialEndsAt,
			logo_url: biz.logoData ? `/v1/businesses/${biz.slug}/logo` : null,
			theme_color: biz.themeColor,
			buffer_min: biz.bufferMin,
			onboarding_complete: svc.n > 0 && wh.n > 0,
			address: {
				street: biz.addressStreet,
				number: biz.addressNumber,
				district: biz.addressDistrict,
				city: biz.addressCity,
				state: biz.addressState,
				zip: biz.addressZip,
			},
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
			address?: unknown;
			theme_color?: unknown;
			buffer_min?: unknown;
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
		// Endereço (F1): objeto opcional com campos de texto; string vazia
		// limpa o campo. Validação: tamanhos máximos por coluna.
		let addressUpdate: Record<string, string | null> | undefined;
		if (body?.address !== undefined) {
			if (typeof body.address !== "object" || body.address === null) {
				return c.json({ error: "address deve ser um objeto" }, 400);
			}
			const a = body.address as Record<string, unknown>;
			const LIMITS: Record<string, number> = {
				street: 200,
				number: 20,
				district: 80,
				city: 80,
				state: 2,
				zip: 9,
			};
			addressUpdate = {};
			for (const [key, max] of Object.entries(LIMITS)) {
				const v = a[key];
				if (v === undefined) continue;
				if (v !== null && typeof v !== "string") {
					return c.json({ error: `address.${key} deve ser string` }, 400);
				}
				const s = typeof v === "string" ? v.trim() : v;
				if (typeof s === "string" && s.length > max) {
					return c.json(
						{ error: `address.${key} deve ter até ${max} caracteres` },
						400,
					);
				}
				addressUpdate[`address${key.charAt(0).toUpperCase()}${key.slice(1)}`] =
					s === "" ? null : (s as string);
			}
			if (Object.keys(addressUpdate).length === 0) {
				addressUpdate = undefined;
			}
		}
		// Cor do tema: "#RRGGBB" ou null (volta pra cor do segmento).
		let themeColor: string | null | undefined;
		if (body?.theme_color !== undefined) {
			if (body.theme_color === null) {
				themeColor = null;
			} else if (
				typeof body.theme_color === "string" &&
				/^#[0-9a-fA-F]{6}$/.test(body.theme_color)
			) {
				themeColor = body.theme_color.toUpperCase();
			} else {
				return c.json(
					{ error: "theme_color inválido (use #RRGGBB ou null)" },
					400,
				);
			}
		}
		// Folga padrão entre atendimentos (0020): minutos, 0..120 de 5 em 5.
		let bufferMin: number | undefined;
		if (body?.buffer_min !== undefined) {
			if (!isValidBufferMin(body.buffer_min)) {
				return c.json(
					{
						error:
							"Intervalo entre atendimentos inválido (0 a 120 minutos, de 5 em 5)",
					},
					400,
				);
			}
			bufferMin = body.buffer_min;
		}
		// PATCH sem nenhum campo conhecido (body null/quebrado/vazio) → 400.
		if (
			businessName === undefined &&
			body?.business_type === undefined &&
			addressUpdate === undefined &&
			themeColor === undefined &&
			bufferMin === undefined
		) {
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
						"Já existe um estabelecimento com esse nome neste segmento. Escolha outro nome.",
				},
				409,
			);
		}
		await db
			.update(businesses)
			.set({
				...(businessName !== undefined ? { name: businessName } : {}),
				...(businessType ? { businessType } : {}),
				...(addressUpdate ?? {}),
				...(themeColor !== undefined ? { themeColor } : {}),
				...(bufferMin !== undefined ? { bufferMin } : {}),
			})
			.where(eq(businesses.id, me.businessId));
		return c.json({
			ok: true,
			business_name: businessName ?? null,
			business_type: businessType ?? null,
			address: addressUpdate ?? null,
			theme_color: themeColor ?? null,
			buffer_min: bufferMin ?? null,
		});
	});

	return routes;
}
