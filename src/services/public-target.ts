/**
 * Link público: de QUEM é a agenda (0026, docs/plano-agregador.md §5).
 *
 * - Business independente: a agenda é a do dono do link (como sempre foi).
 * - Business agregador: o cliente escolhe um profissional no seletor:
 *   - "owner": o próprio dono do agregador, se ele atende (tem serviço e
 *     horário — D4);
 *   - id de um vínculo ATIVO e visível: a agenda é a do profissional, no
 *     business DELE (aggregator = o agregador, para marcar a origem).
 */

import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/connection.js";
import {
	businesses,
	professionalLinks,
	services,
	users,
	workingHours,
} from "../db/schema.js";
import { proLabel } from "../domain/pro-label.js";

type Biz = typeof businesses.$inferSelect;
type User = typeof users.$inferSelect;

/** Página do link: o business do slug e o dono dele. */
export type PublicPage = { biz: Biz; owner: User };

/** Agenda que recebe o agendamento. */
export type PublicTarget = {
	biz: Biz;
	pro: User;
	/** agregador por onde o cliente chegou (null = link próprio) */
	aggregator: Biz | null;
};

export type PublicProfessional = {
	id: string;
	name: string;
	logo_url: string | null;
};

export const OWNER_ID = "owner";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canWrite(status: string | null, trialEndsAt: Date | null) {
	if (status === "active") return true;
	if (status === "trial")
		return trialEndsAt === null || trialEndsAt > new Date();
	return false;
}

export function isAggregator(page: PublicPage) {
	return page.biz.accountKind === "aggregator";
}

export async function loadPage(
	db: Db,
	slug: string,
): Promise<PublicPage | null> {
	const biz = (
		await db.select().from(businesses).where(eq(businesses.slug, slug)).limit(1)
	)[0];
	if (!biz) return null;
	// dono do link = 1º usuário do business
	const owner = (
		await db
			.select()
			.from(users)
			.where(eq(users.businessId, biz.id))
			.orderBy(asc(users.createdAt))
			.limit(1)
	)[0];
	/* v8 ignore next 3 -- inatingível: todo business nasce com user (sync atômico) */
	if (!owner) return null;
	return { biz, owner };
}

/** Dono do agregador atende? (D4: tem serviço ativo e horário) */
async function ownerAttends(db: Db, page: PublicPage) {
	const [row] = await db
		.select({
			svc: sql<number>`(SELECT count(*)::int FROM ${services} WHERE ${services.businessId} = ${page.biz.id} AND ${services.archivedAt} IS NULL)`,
			wh: sql<number>`(SELECT count(*)::int FROM ${workingHours} WHERE ${workingHours.userId} = ${page.owner.id})`,
		})
		.from(businesses)
		.where(eq(businesses.id, page.biz.id));
	/* v8 ignore next -- a linha do próprio business sempre existe */
	return (row?.svc ?? 0) > 0 && (row?.wh ?? 0) > 0;
}

function logoUrl(b: Pick<Biz, "slug" | "logoMime">) {
	return b.logoMime ? `/v1/businesses/${b.slug}/logo` : null;
}

/** Vínculos que aparecem no seletor (ativos, visíveis e com conta em dia). */
async function visibleLinks(db: Db, page: PublicPage, linkId?: string) {
	const rows = await db
		.select({ link: professionalLinks, pro: users, proBiz: businesses })
		.from(professionalLinks)
		.innerJoin(users, eq(users.id, professionalLinks.professionalUserId))
		.innerJoin(businesses, eq(businesses.id, users.businessId))
		.where(
			and(
				eq(professionalLinks.aggregatorBusinessId, page.biz.id),
				eq(professionalLinks.status, "active"),
				eq(professionalLinks.showOnLink, true),
				...(linkId ? [eq(professionalLinks.id, linkId)] : []),
			),
		)
		.orderBy(asc(professionalLinks.position), asc(users.name));
	// D5: profissional com teste/assinatura vencidos não recebe agendamento
	return rows.filter((r) =>
		canWrite(r.proBiz.subscriptionStatus, r.proBiz.trialEndsAt),
	);
}

/** Seletor do link do agregador (vazio para independente). */
export async function listProfessionals(
	db: Db,
	page: PublicPage,
): Promise<PublicProfessional[]> {
	if (!isAggregator(page)) return [];
	const out: PublicProfessional[] = [];
	if (await ownerAttends(db, page)) {
		out.push({
			id: OWNER_ID,
			name: proLabel(page.owner.name, page.biz.name),
			logo_url: logoUrl(page.biz),
		});
	}
	for (const r of await visibleLinks(db, page)) {
		out.push({
			id: r.link.id,
			name: proLabel(r.pro.name, r.proBiz.name),
			logo_url: logoUrl(r.proBiz),
		});
	}
	return out;
}

/**
 * Agenda escolhida. Independente: ignora o parâmetro (link de sempre).
 * Agregador: exige um profissional do seletor.
 */
export async function resolveTarget(
	db: Db,
	page: PublicPage,
	professionalId: unknown,
): Promise<PublicTarget | { error: string; status: 400 | 404 }> {
	if (!isAggregator(page)) {
		return { biz: page.biz, pro: page.owner, aggregator: null };
	}
	if (professionalId === undefined || professionalId === "") {
		return { error: "Escolha o profissional", status: 400 };
	}
	const unavailable = {
		error: "Esse profissional não está disponível neste link",
		status: 404,
	} as const;
	if (professionalId === OWNER_ID) {
		if (!(await ownerAttends(db, page))) return unavailable;
		return { biz: page.biz, pro: page.owner, aggregator: null };
	}
	if (typeof professionalId !== "string" || !UUID.test(professionalId)) {
		return unavailable;
	}
	const [row] = await visibleLinks(db, page, professionalId);
	if (!row) return unavailable;
	return { biz: row.proBiz, pro: row.pro, aggregator: page.biz };
}
