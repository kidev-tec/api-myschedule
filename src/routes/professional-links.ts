/**
 * Vínculos agregador ↔ profissional (0026, docs/plano-agregador.md).
 *
 * - GET   /links?as=aggregator|professional — vínculos vivos (pendentes/ativos)
 * - POST  /links { code }                   — E-… = profissional pede entrada;
 *                                             P-… = agregador convida
 * - POST  /links/:id/accept | /reject       — só o lado convidado
 * - POST  /links/:id/cancel                 — só quem pediu, enquanto pendente
 * - POST  /links/:id/end                    — qualquer lado, vínculo ativo
 * - PATCH /links/:id { show_on_link, position } — agregador (seletor do link)
 *
 * O vínculo nunca é apagado: muda de status (histórico/auditoria).
 * Cada mudança avisa o outro lado (sino + push) via notify().
 */

import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import {
	appointments,
	businesses,
	professionalLinks,
	users,
} from "../db/schema.js";
import { parseLinkCode } from "../domain/link-code.js";
import { proLabel } from "../domain/pro-label.js";
import { type NotificationType, notify } from "../services/notify.js";
import type { AppEnv } from "../types.js";

type Link = typeof professionalLinks.$inferSelect;
type User = typeof users.$inferSelect;
type Biz = typeof businesses.$inferSelect;

const LIVE = ["pending", "active"];

function isUuid(v: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		v,
	);
}

/** Drizzle embrulha o erro do postgres-js: o código SQLSTATE vem em cause. */
function pgErrorCode(err: unknown): string | undefined {
	/* v8 ignore next -- formato do erro varia por driver; só 23505 importa */
	return (err as { cause?: { code?: string } }).cause?.code;
}

async function loadMe(db: Db, uid: string) {
	const me = (
		await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
	)[0];
	if (!me) return null;
	const biz = (
		await db
			.select()
			.from(businesses)
			.where(eq(businesses.id, me.businessId))
			.limit(1)
	)[0];
	/* v8 ignore next -- defensivo: user sempre tem business (FK NOT NULL) */
	if (!biz) return null;
	return { me, biz };
}

/** Dono do business agregador = quem recebe os avisos do lado agregador. */
async function aggregatorOwner(db: Db, businessId: string) {
	return (
		await db
			.select()
			.from(users)
			.where(eq(users.businessId, businessId))
			.orderBy(asc(users.createdAt))
			.limit(1)
	)[0];
}

function logoUrl(b: Pick<Biz, "slug" | "logoMime">): string | null {
	return b.logoMime ? `/v1/businesses/${b.slug}/logo` : null;
}

export function professionalLinkRoutes(databaseUrl: string) {
	const db: Db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	/** Avisa um usuário sem atrasar a resposta (notify nunca lança). */
	function tell(
		userId: string | undefined,
		type: NotificationType,
		title: string,
		body: string,
		linkId: string,
	) {
		/* v8 ignore next -- defensivo: business agregador sempre tem dono */
		if (!userId) return;
		void notify(databaseUrl, {
			userId,
			type,
			title,
			body,
			data: { link_id: linkId },
		});
	}

	function serialize(
		l: Link,
		meSide: "aggregator" | "professional",
		counterpart: Record<string, unknown>,
	) {
		return {
			id: l.id,
			status: l.status,
			requested_by: l.requestedBy,
			// pendente e quem pediu foi o outro lado → cabe a mim responder
			awaiting_me: l.status === "pending" && l.requestedBy !== meSide,
			show_on_link: l.showOnLink,
			position: l.position,
			created_at: l.createdAt.toISOString(),
			responded_at: l.respondedAt?.toISOString() ?? null,
			counterpart,
		};
	}

	routes.get("/links", async (c) => {
		const ctx = await loadMe(db, c.get("authUser").uid);
		if (!ctx) return c.json({ error: "Usuário não encontrado" }, 404);
		const as = c.req.query("as");
		if (as !== "aggregator" && as !== "professional") {
			return c.json({ error: "Informe as=aggregator ou as=professional" }, 400);
		}
		if (as === "aggregator") {
			const rows = await db
				.select({ link: professionalLinks, pro: users, proBiz: businesses })
				.from(professionalLinks)
				.innerJoin(users, eq(users.id, professionalLinks.professionalUserId))
				.innerJoin(businesses, eq(businesses.id, users.businessId))
				.where(
					and(
						eq(professionalLinks.aggregatorBusinessId, ctx.biz.id),
						inArray(professionalLinks.status, LIVE),
					),
				)
				.orderBy(asc(professionalLinks.position), asc(users.name));
			return c.json({
				links: rows.map((r) =>
					serialize(r.link, "aggregator", {
						name: r.pro.name,
						business_name: r.proBiz.name,
						pro_code: r.pro.proCode,
						logo_url: logoUrl(r.proBiz),
					}),
				),
			});
		}
		const rows = await db
			.select({ link: professionalLinks, agg: businesses })
			.from(professionalLinks)
			.innerJoin(
				businesses,
				eq(businesses.id, professionalLinks.aggregatorBusinessId),
			)
			.where(
				and(
					eq(professionalLinks.professionalUserId, ctx.me.id),
					inArray(professionalLinks.status, LIVE),
				),
			)
			.orderBy(asc(businesses.name));
		return c.json({
			links: rows.map((r) =>
				serialize(r.link, "professional", {
					name: r.agg.name,
					business_name: r.agg.name,
					city: r.agg.addressCity,
					logo_url: logoUrl(r.agg),
				}),
			),
		});
	});

	routes.post("/links", async (c) => {
		const ctx = await loadMe(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!ctx) return c.json({ error: "Usuário não encontrado" }, 404);
		const body = (await c.req.json().catch(() => null)) as {
			code?: unknown;
		} | null;
		const parsed = parseLinkCode(body?.code);
		if (!parsed) {
			return c.json(
				{ error: "Código inválido. Confira e digite de novo." },
				400,
			);
		}

		let aggregatorBizId: string;
		let proUserId: string;
		let requestedBy: "professional" | "aggregator";
		let notifyUserId: string | undefined;
		let notifyBody: string;

		if (parsed.kind === "aggregator") {
			// profissional pede entrada num estabelecimento
			if (ctx.biz.accountKind === "aggregator") {
				return c.json(
					{
						error:
							"Contas de estabelecimento não podem se vincular a outro estabelecimento.",
					},
					400,
				);
			}
			const agg = (
				await db
					.select()
					.from(businesses)
					.where(
						and(
							eq(businesses.aggregatorCode, parsed.code),
							eq(businesses.accountKind, "aggregator"),
						),
					)
					.limit(1)
			)[0];
			if (!agg) {
				return c.json(
					{ error: "Não encontramos um estabelecimento com esse código." },
					404,
				);
			}
			aggregatorBizId = agg.id;
			proUserId = ctx.me.id;
			requestedBy = "professional";
			notifyUserId = (await aggregatorOwner(db, agg.id))?.id;
			notifyBody = `${proLabel(ctx.me.name, ctx.biz.name)} quer fazer parte de ${agg.name}. Toque para responder.`;
		} else {
			// estabelecimento convida um profissional
			if (ctx.biz.accountKind !== "aggregator") {
				return c.json(
					{
						error: "Só contas de estabelecimento podem convidar profissionais.",
					},
					403,
				);
			}
			const target = (
				await db
					.select({ user: users, biz: businesses })
					.from(users)
					.innerJoin(businesses, eq(businesses.id, users.businessId))
					.where(eq(users.proCode, parsed.code))
					.limit(1)
			)[0];
			if (!target) {
				return c.json(
					{ error: "Não encontramos um profissional com esse código." },
					404,
				);
			}
			if (target.biz.id === ctx.biz.id) {
				return c.json({ error: "Esse é o seu próprio código." }, 400);
			}
			if (target.biz.accountKind === "aggregator") {
				return c.json(
					{ error: "Esse profissional usa uma conta de estabelecimento." },
					400,
				);
			}
			aggregatorBizId = ctx.biz.id;
			proUserId = target.user.id;
			requestedBy = "aggregator";
			notifyUserId = target.user.id;
			notifyBody = `${ctx.biz.name} convidou você para fazer parte da equipe. Toque para responder.`;
		}

		let link: Link | undefined;
		try {
			[link] = await db
				.insert(professionalLinks)
				.values({
					aggregatorBusinessId: aggregatorBizId,
					professionalUserId: proUserId,
					requestedBy,
				})
				.returning();
		} catch (err) {
			// índice único parcial (vivos): só 23505 é esperado aqui
			/* v8 ignore next -- erro de banco inesperado: o Hono responde 500 */
			if (pgErrorCode(err) !== "23505") throw err;
			return c.json(
				{ error: "Já existe um pedido ou vínculo ativo entre vocês." },
				409,
			);
		}
		/* v8 ignore next -- INSERT..RETURNING nunca é vazio no Postgres */
		if (!link) return c.json({ error: "falha ao criar vínculo" }, 500);
		tell(
			notifyUserId,
			"link_request",
			"Novo pedido de vínculo",
			notifyBody,
			link.id,
		);
		return c.json(
			{ id: link.id, status: link.status, requested_by: requestedBy },
			201,
		);
	});

	/**
	 * Carrega o vínculo e diz de que lado o usuário logado está.
	 * Quem não é parte do vínculo recebe 404 (não revela que existe).
	 */
	async function loadParty(uid: string, id: string) {
		const ctx = await loadMe(db, uid);
		/* v8 ignore next -- inatingível: paywall retorna 404 antes */
		if (!ctx) return null;
		if (!isUuid(id)) return null;
		const row = (
			await db
				.select({ link: professionalLinks, agg: businesses, pro: users })
				.from(professionalLinks)
				.innerJoin(
					businesses,
					eq(businesses.id, professionalLinks.aggregatorBusinessId),
				)
				.innerJoin(users, eq(users.id, professionalLinks.professionalUserId))
				.where(eq(professionalLinks.id, id))
				.limit(1)
		)[0];
		if (!row) return null;
		let side: "aggregator" | "professional";
		if (row.agg.id === ctx.biz.id) side = "aggregator";
		else if (row.pro.id === ctx.me.id) side = "professional";
		else return null;
		// negócio do profissional: identifica quem é nos avisos (proLabel)
		const proBiz = (
			await db
				.select({ name: businesses.name })
				.from(businesses)
				.where(eq(businesses.id, row.pro.businessId))
				.limit(1)
		)[0];
		const proName = proLabel(row.pro.name, proBiz?.name);
		return { ...row, side, me: ctx.me, proName };
	}

	const notFound = { error: "Vínculo não encontrado" };

	/** O outro lado do vínculo (quem recebe o aviso). */
	async function otherSide(p: {
		side: "aggregator" | "professional";
		agg: Biz;
		pro: User;
	}) {
		return p.side === "aggregator"
			? p.pro.id
			: (await aggregatorOwner(db, p.agg.id))?.id;
	}

	for (const action of ["accept", "reject"] as const) {
		routes.post(`/links/:id/${action}`, async (c) => {
			const p = await loadParty(c.get("authUser").uid, c.req.param("id"));
			if (!p) return c.json(notFound, 404);
			if (p.link.status !== "pending") {
				return c.json({ error: "Esse pedido já foi respondido." }, 409);
			}
			if (p.link.requestedBy === p.side) {
				return c.json(
					{ error: "Quem responde o pedido é o outro lado do vínculo." },
					403,
				);
			}
			const status = action === "accept" ? "active" : "rejected";
			await db
				.update(professionalLinks)
				.set({ status, respondedAt: new Date() })
				.where(eq(professionalLinks.id, p.link.id));
			const who = p.side === "aggregator" ? p.agg.name : p.proName;
			tell(
				await otherSide(p),
				action === "accept" ? "link_accepted" : "link_rejected",
				action === "accept" ? "Vínculo aprovado" : "Pedido de vínculo recusado",
				action === "accept"
					? `${who} aprovou o vínculo.`
					: `${who} recusou o pedido de vínculo.`,
				p.link.id,
			);
			return c.json({ id: p.link.id, status });
		});
	}

	routes.post("/links/:id/cancel", async (c) => {
		const p = await loadParty(c.get("authUser").uid, c.req.param("id"));
		if (!p) return c.json(notFound, 404);
		if (p.link.status !== "pending") {
			return c.json({ error: "Esse pedido já foi respondido." }, 409);
		}
		if (p.link.requestedBy !== p.side) {
			return c.json(
				{ error: "Só quem fez o pedido pode cancelar. Você pode recusar." },
				403,
			);
		}
		await db
			.update(professionalLinks)
			.set({ status: "canceled", respondedAt: new Date() })
			.where(eq(professionalLinks.id, p.link.id));
		return c.json({ id: p.link.id, status: "canceled" });
	});

	routes.post("/links/:id/end", async (c) => {
		const p = await loadParty(c.get("authUser").uid, c.req.param("id"));
		if (!p) return c.json(notFound, 404);
		if (p.link.status !== "active") {
			return c.json({ error: "Esse vínculo não está ativo." }, 409);
		}
		await db
			.update(professionalLinks)
			.set({ status: "ended", endedAt: new Date() })
			.where(eq(professionalLinks.id, p.link.id));
		// D2: agendamentos futuros que vieram por este agregador continuam
		// valendo (são do profissional) — o profissional fica sabendo quantos
		const [future] = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(appointments)
			.where(
				and(
					eq(appointments.userId, p.pro.id),
					eq(appointments.aggregatorBusinessId, p.agg.id),
					gt(appointments.startsAt, new Date()),
					inArray(appointments.status, ["pending", "confirmed"]),
				),
			);
		/* v8 ignore next -- count(*) sempre devolve 1 linha */
		const futureCount = future?.n ?? 0;
		const keep =
			futureCount > 0
				? ` ${futureCount === 1 ? "1 agendamento futuro que veio" : `${futureCount} agendamentos futuros que vieram`} por ${p.agg.name} continua${futureCount === 1 ? "" : "m"} na sua agenda.`
				: "";
		if (p.side === "aggregator") {
			tell(
				p.pro.id,
				"link_ended",
				"Vínculo encerrado",
				`${p.agg.name} encerrou o vínculo com você.${keep}`,
				p.link.id,
			);
		} else {
			tell(
				await otherSide(p),
				"link_ended",
				"Vínculo encerrado",
				`${p.proName} saiu de ${p.agg.name}.`,
				p.link.id,
			);
		}
		return c.json({
			id: p.link.id,
			status: "ended",
			future_appointments: futureCount,
		});
	});

	routes.patch("/links/:id", async (c) => {
		const p = await loadParty(c.get("authUser").uid, c.req.param("id"));
		if (!p) return c.json(notFound, 404);
		if (p.side !== "aggregator") {
			return c.json(
				{ error: "Só o estabelecimento organiza os profissionais do link." },
				403,
			);
		}
		const body = (await c.req.json().catch(() => null)) as {
			show_on_link?: unknown;
			position?: unknown;
		} | null;
		const set: { showOnLink?: boolean; position?: number } = {};
		if (body?.show_on_link !== undefined) {
			if (typeof body.show_on_link !== "boolean") {
				return c.json(
					{ error: "show_on_link deve ser verdadeiro ou falso" },
					400,
				);
			}
			set.showOnLink = body.show_on_link;
		}
		if (body?.position !== undefined) {
			if (
				typeof body.position !== "number" ||
				!Number.isInteger(body.position) ||
				body.position < 0 ||
				body.position > 999
			) {
				return c.json({ error: "Posição inválida (0 a 999)" }, 400);
			}
			set.position = body.position;
		}
		if (Object.keys(set).length === 0) {
			return c.json({ error: "nada para atualizar" }, 400);
		}
		const [row] = await db
			.update(professionalLinks)
			.set(set)
			.where(eq(professionalLinks.id, p.link.id))
			.returning();
		/* v8 ignore next -- UPDATE..RETURNING do vínculo carregado volta 1 linha */
		if (!row) return c.json(notFound, 404);
		return c.json({
			id: row.id,
			show_on_link: row.showOnLink,
			position: row.position,
		});
	});

	return routes;
}
