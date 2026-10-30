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
		return { error: "Escolhe os serviços do kit" };
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
