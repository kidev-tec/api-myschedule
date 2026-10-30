/**
 * 0021 — kits (combos) de serviço. Um kit é uma linha de `services` com
 * is_kit = true; os serviços que ele inclui ficam em service_kit_items.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/connection.js";
import { serviceKitItems, services } from "../db/schema.js";

export const KIT_MIN_ITEMS = 2;
export const KIT_MAX_ITEMS = 10;

export type KitItem = {
	id: string;
	name: string;
	duration_min: number;
	price_cents: number;
};

/** Itens (em ordem) de cada kit pedido. Kit sem item vem com lista vazia. */
export async function kitItemsFor(
	db: Db,
	kitIds: string[],
): Promise<Map<string, KitItem[]>> {
	const out = new Map<string, KitItem[]>(kitIds.map((id) => [id, []]));
	if (kitIds.length === 0) return out;
	const rows = await db
		.select({
			kitId: serviceKitItems.kitId,
			id: services.id,
			name: services.name,
			durationMin: services.durationMin,
			priceCents: services.priceCents,
		})
		.from(serviceKitItems)
		.innerJoin(services, eq(services.id, serviceKitItems.serviceId))
		.where(inArray(serviceKitItems.kitId, kitIds))
		.orderBy(asc(serviceKitItems.position));
	for (const r of rows) {
		out.get(r.kitId)?.push({
			id: r.id,
			name: r.name,
			duration_min: r.durationMin,
			price_cents: r.priceCents,
		});
	}
	return out;
}

/**
 * Valida a lista de itens de um kit: 2..10 serviços distintos, ativos, do
 * mesmo negócio e que não sejam kits (sem kit dentro de kit) nem o próprio.
 */
export async function validateKitItems(
	db: Db,
	businessId: string,
	raw: unknown,
	selfId?: string,
): Promise<{ ids: string[] } | { error: string }> {
	if (
		!Array.isArray(raw) ||
		raw.some(
			(v) =>
				typeof v !== "string" || !/^[0-9a-f-]{36}$/i.test(v) || v === selfId,
		)
	) {
		return { error: "Escolha os serviços do kit" };
	}
	const ids = raw as string[];
	if (new Set(ids).size !== ids.length) {
		return { error: "O mesmo serviço aparece duas vezes no kit" };
	}
	if (ids.length < KIT_MIN_ITEMS || ids.length > KIT_MAX_ITEMS) {
		return {
			error: `Um kit tem de ${KIT_MIN_ITEMS} a ${KIT_MAX_ITEMS} serviços`,
		};
	}
	const found = await db
		.select({ id: services.id, isKit: services.isKit })
		.from(services)
		.where(
			and(
				inArray(services.id, ids),
				eq(services.businessId, businessId),
				isNull(services.archivedAt),
			),
		);
	if (found.length !== ids.length) {
		return { error: "Algum serviço do kit não existe mais" };
	}
	if (found.some((s) => s.isKit)) {
		return { error: "Um kit não pode ter outro kit dentro" };
	}
	return { ids };
}

/** Kits ATIVOS que incluem o serviço (bloqueia a exclusão dele). */
export async function activeKitsWith(
	db: Db,
	serviceId: string,
): Promise<{ id: string; name: string }[]> {
	return db
		.select({ id: services.id, name: services.name })
		.from(serviceKitItems)
		.innerJoin(services, eq(services.id, serviceKitItems.kitId))
		.where(
			and(
				eq(serviceKitItems.serviceId, serviceId),
				isNull(services.archivedAt),
			),
		);
}

/**
 * 0022 — vários serviços num agendamento só. Resolve a lista escolhida
 * (2..10 serviços avulsos ativos, sem kit no meio) num kit OCULTO (adhoc,
 * já arquivado: fora de listas/wizard/link) com nome "A + B", duração e
 * preço somados. A mesma combinação (mesma ordem) é reaproveitada e tem
 * duração/preço atualizados pros valores atuais dos serviços.
 */
export async function resolveCombo(
	db: Db,
	businessId: string,
	raw: unknown,
): Promise<
	| { serviceId: string; name: string; durationMin: number; priceCents: number }
	| { error: string }
> {
	const v = await validateKitItems(db, businessId, raw);
	if ("error" in v) {
		// mesmas regras do kit, com mensagem de "serviços escolhidos"
		const msg = v.error.includes("outro kit")
			? "Kit não combina com outros serviços — escolha o kit sozinho"
			: v.error.includes("de 2 a")
				? "Escolha de 2 a 10 serviços"
				: v.error.replace(" do kit", "").replace(" no kit", "");
		return { error: msg };
	}
	const rows = await db
		.select({
			id: services.id,
			name: services.name,
			durationMin: services.durationMin,
			priceCents: services.priceCents,
		})
		.from(services)
		.where(inArray(services.id, v.ids));
	const byId = new Map(rows.map((r) => [r.id, r]));
	const chosen = v.ids.map((id) => byId.get(id) as (typeof rows)[number]);
	const full = chosen.map((s) => s.name).join(" + ");
	const name = full.length <= 120 ? full : `${full.slice(0, 119)}…`;
	const durationMin = chosen.reduce((a, s) => a + s.durationMin, 0);
	const priceCents = chosen.reduce((a, s) => a + s.priceCents, 0);

	// reaproveita a mesma combinação (mesmos itens, mesma ordem)
	const candidates = await db
		.select({ id: services.id })
		.from(services)
		.where(
			and(
				eq(services.businessId, businessId),
				eq(services.adhoc, true),
				eq(services.name, name),
			),
		);
	const items = await kitItemsFor(
		db,
		candidates.map((c) => c.id),
	);
	const same = candidates.find(
		(c) =>
			items
				.get(c.id)
				?.map((i) => i.id)
				.join() === v.ids.join(),
	);
	if (same) {
		await db
			.update(services)
			.set({ durationMin, priceCents })
			.where(eq(services.id, same.id));
		return { serviceId: same.id, name, durationMin, priceCents };
	}
	const serviceId = await db.transaction(async (tx) => {
		const [row] = await tx
			.insert(services)
			.values({
				businessId,
				name,
				durationMin,
				priceCents,
				isKit: true,
				adhoc: true,
				archivedAt: new Date(),
			})
			.returning({ id: services.id });
		/* v8 ignore next -- INSERT..RETURNING nunca é vazio no Postgres */
		if (!row) throw new Error("falha ao montar os serviços");
		await tx.insert(serviceKitItems).values(
			v.ids.map((serviceId, position) => ({
				kitId: row.id,
				serviceId,
				position,
			})),
		);
		return row.id;
	});
	return { serviceId, name, durationMin, priceCents };
}
