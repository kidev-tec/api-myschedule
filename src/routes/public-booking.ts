/**
 * RF-07 — Link público de agendamento.
 *
 * Rotas SEM auth Firebase (o cliente do salão não tem conta):
 * - GET  /p/:slug       → página HTML standalone (zero build, inline CSS/JS)
 * - GET  /p/:slug/info  → JSON { business, services, working_hours }
 * - POST /p/:slug/book  → { name, phone, service_id, starts_at } → cria
 *                          client (find-or-create por telefone) + appointment
 *                          pending com source='public_link'
 *
 * Segurança: slug é a única credencial. Rate-limiting básico em memória
 * (10 bookings/min/IP). Paywall respeitado: business com trial vencido
 * responde 402 no book (leitura/info continua livre).
 */

import {
	and,
	asc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import {
	appointments,
	businesses,
	clients,
	services,
	timeOffs as timeOffsTable,
	users,
	workingHours,
} from "../db/schema.js";
import { overlaps } from "../domain/booking.js";
import { verifyConfirmationToken } from "../domain/confirmation-token.js";
import { occupiedEnd } from "../domain/duration.js";
import { phoneDigitsBr, phoneMatchKeys } from "../domain/phone-br.js";
import { proLabel } from "../domain/pro-label.js";
import { kitItemsFor, resolveCombo } from "../domain/service-kits.js";
import { notify } from "../services/notify.js";
import {
	canWrite,
	isAggregator,
	listProfessionals,
	loadPage,
	type PublicPage,
	type PublicProfessional,
	type PublicTarget,
	resolveTarget,
} from "../services/public-target.js";

function isUuid(v: unknown): v is string {
	return (
		typeof v === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
	);
}

// ---- rate limit em memória (por processo; ok pra MVP single-instância)
const hits = new Map<string, number[]>();
export function rateLimited(
	key: string,
	max: number,
	windowMs: number,
): boolean {
	const now = Date.now();
	const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
	arr.push(now);
	hits.set(key, arr);
	return arr.length > max;
}

/** Limpa contadores (uso em testes). */
export function resetRateLimit() {
	hits.clear();
}

type Loaded = {
	biz: typeof businesses.$inferSelect;
	pro: typeof users.$inferSelect;
} | null;

/** Dono do link (confirmação de presença usa o slug do próprio profissional). */
async function loadBySlug(db: Db, slug: string): Promise<Loaded> {
	const page = await loadPage(db, slug);
	return page ? { biz: page.biz, pro: page.owner } : null;
}

/**
 * JSON do /info. Página = business do slug (nome, endereço, segmento).
 * Agenda = target (fuso, folga, profissional). Agregador sem profissional
 * escolhido: target null → catálogo vazio, só o seletor.
 */
function infoJson(
	page: PublicPage,
	target: PublicTarget | null,
	svc: unknown[],
	hours: unknown[],
	professionals: PublicProfessional[],
) {
	const agenda = target?.biz ?? page.biz;
	return {
		business: {
			name: page.biz.name,
			business_type: page.biz.businessType,
			timezone: agenda.timezone,
			// 0020: folga após cada atendimento — a grade de slots soma isso
			buffer_min: agenda.bufferMin,
			// endereço (F1): onde o atendimento acontece — cada campo pode ser
			// null (business sem endereço cadastrado não exibe a linha)
			address: {
				street: page.biz.addressStreet,
				number: page.biz.addressNumber,
				district: page.biz.addressDistrict,
				city: page.biz.addressCity,
				state: page.biz.addressState,
				zip: page.biz.addressZip,
			},
		},
		// agregador: nome + negócio (vários profissionais na mesma página);
		// independente: como sempre foi
		professional: {
			name:
				target && isAggregator(page)
					? proLabel(target.pro.name, target.biz.name)
					: (target?.pro.name ?? page.biz.name),
		},
		services: svc,
		working_hours: hours,
		// 0026: só no link de agregador (seletor de profissional)
		...(isAggregator(page) ? { professionals } : {}),
	};
}

export function publicBookingRoutes(databaseUrl: string) {
	const db = getDb(databaseUrl);
	const routes = new Hono();

	// ---- JSON: perfil + serviços + horários
	routes.get("/p/:slug/info", async (c) => {
		const slug = c.req.param("slug");
		const page = await loadPage(db, slug);
		if (!page) return c.json({ error: "link não encontrado" }, 404);
		const professionals = await listProfessionals(db, page);
		const chosen = c.req.query("professional");
		// agregador sem escolha: só o seletor
		if (isAggregator(page) && !chosen) {
			return c.json(infoJson(page, null, [], [], professionals));
		}
		const loaded = await resolveTarget(db, page, chosen);
		if ("error" in loaded) {
			return c.json({ error: loaded.error }, loaded.status);
		}

		const svc = await db
			.select({
				id: services.id,
				name: services.name,
				duration_min: services.durationMin,
				price_cents: services.priceCents,
				is_kit: services.isKit,
			})
			.from(services)
			.where(
				and(
					eq(services.businessId, loaded.biz.id),
					isNull(services.archivedAt),
				),
			);
		// 0021: kit mostra o que inclui ("Corte + Barba")
		const kitItems = await kitItemsFor(
			db,
			svc.filter((s) => s.is_kit).map((s) => s.id),
		);
		const hours = await db
			.select({
				weekday: workingHours.weekday,
				start_time: workingHours.startTime,
				end_time: workingHours.endTime,
			})
			.from(workingHours)
			.where(eq(workingHours.userId, loaded.pro.id));

		return c.json(
			infoJson(
				page,
				loaded,
				svc.map((s) =>
					s.is_kit
						? {
								...s,
								/* v8 ignore next -- kitItemsFor devolve lista p/ todo kit */
								items: (kitItems.get(s.id) ?? []).map((i) => i.name),
								// soma dos itens: > price_cents = kit com desconto
								/* v8 ignore next -- kitItemsFor devolve lista p/ todo kit */
								items_total_cents: (kitItems.get(s.id) ?? []).reduce(
									(a, i) => a + i.price_cents,
									0,
								),
							}
						: s,
				),
				hours,
				professionals,
			),
		);
	});

	// ---- booking público
	routes.post("/p/:slug/book", async (c) => {
		const ip =
			c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
		if (rateLimited(`book:${ip}`, 10, 60_000)) {
			return c.json({ error: "muitas tentativas, aguarde um minuto" }, 429);
		}

		const slug = c.req.param("slug");
		const page = await loadPage(db, slug);
		if (!page) return c.json({ error: "link não encontrado" }, 404);
		const unavailable = () =>
			c.json(
				{ error: "agenda temporariamente indisponível para novos horários" },
				402,
			);
		// D5: no link do agregador, o agregador também precisa estar em dia
		if (!canWrite(page.biz.subscriptionStatus, page.biz.trialEndsAt)) {
			return unavailable();
		}

		const body = (await c.req.json().catch(() => null)) as {
			name?: unknown;
			phone?: unknown;
			service_id?: unknown;
			service_ids?: unknown;
			starts_at?: unknown;
			duration_min?: unknown;
			professional_id?: unknown;
		} | null;
		const loaded = await resolveTarget(db, page, body?.professional_id);
		if ("error" in loaded) {
			return c.json({ error: loaded.error }, loaded.status);
		}
		/* v8 ignore next 3 -- independente/dono: já checado acima (mesmo business);
		   profissional vencido nem aparece no seletor (visibleLinks filtra) */
		if (!canWrite(loaded.biz.subscriptionStatus, loaded.biz.trialEndsAt)) {
			return unavailable();
		}
		// Público deriva estritamente do serviço: não aceita override de duração.
		if (body?.duration_min !== undefined) {
			return c.json(
				{ error: "A duração não pode ser alterada no agendamento pelo link" },
				400,
			);
		}
		const name =
			typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
		const phone =
			typeof body?.phone === "string" ? body.phone.replace(/[^\d+]/g, "") : "";
		const digits = phone.replace(/\D/g, "");
		if (name.length < 1 || digits.length < 10) {
			return c.json(
				{ error: "informe nome e telefone válidos (com DDD)" },
				400,
			);
		}
		// 0022: vários serviços (service_ids 2+) viram um horário só "A + B"
		let svc: { id: string; name: string; durationMin: number } | undefined;
		if (Array.isArray(body?.service_ids) && body.service_ids.length > 1) {
			const combo = await resolveCombo(db, loaded.biz.id, body.service_ids);
			if ("error" in combo) return c.json({ error: combo.error }, 400);
			svc = {
				id: combo.serviceId,
				name: combo.name,
				durationMin: combo.durationMin,
			};
		} else {
			const oneId = Array.isArray(body?.service_ids)
				? body.service_ids[0]
				: body?.service_id;
			if (typeof oneId !== "string" || !isUuid(oneId)) {
				return c.json({ error: "escolha um serviço" }, 400);
			}
			svc = (
				await db
					.select()
					.from(services)
					.where(
						and(
							eq(services.id, oneId),
							eq(services.businessId, loaded.biz.id),
							isNull(services.archivedAt),
						),
					)
					.limit(1)
			)[0];
			if (!svc) return c.json({ error: "serviço indisponível" }, 400);
		}

		const startsAtRaw = body?.starts_at;
		const start = new Date(
			typeof startsAtRaw === "string" ? startsAtRaw : "inválido",
		);
		if (Number.isNaN(start.getTime())) {
			return c.json({ error: "horário inválido" }, 400);
		}
		if (start.getTime() < Date.now()) {
			return c.json({ error: "escolha um horário no futuro" }, 400);
		}
		const end = new Date(start.getTime() + svc.durationMin * 60_000);
		// 0020: link público sempre usa a folga padrão do negócio
		const bufferMin = loaded.biz.bufferMin;
		const busyUntil = occupiedEnd(end, bufferMin);

		// conflito (mesma semântica do CRUD autenticado): [início, fim + folga)
		const existing = await db
			.select({
				startsAt: appointments.startsAt,
				endsAt: appointments.endsAt,
				bufferMin: appointments.bufferMin,
			})
			.from(appointments)
			.where(
				and(
					eq(appointments.businessId, loaded.biz.id),
					eq(appointments.userId, loaded.pro.id),
					sql`${appointments.status} IN ('pending', 'confirmed')`,
				),
			);
		for (const row of existing) {
			if (
				overlaps(
					row.startsAt,
					occupiedEnd(row.endsAt, row.bufferMin),
					start,
					busyUntil,
				)
			) {
				return c.json({ error: "esse horário acabou de ser ocupado" }, 409);
			}
		}

		// Cliente já cadastrado? Procura pelo celular (só dígitos, com ou sem
		// o 55) entre os ativos — mantém o cadastro e o nome que já existem.
		// Sem cadastro: cria só com nome + celular, marcado como vindo do
		// link (o app mostra pra o prestador pedir o cadastro completo).
		let client = (
			await db
				.select()
				.from(clients)
				.where(
					and(
						eq(clients.businessId, loaded.biz.id),
						isNull(clients.deletedAt),
						inArray(
							sql`regexp_replace(${clients.phoneE164}, '[^0-9]', '', 'g')`,
							phoneMatchKeys(phone),
						),
					),
				)
				.orderBy(asc(clients.createdAt))
				.limit(1)
		)[0];
		if (!client) {
			client = (
				await db
					.insert(clients)
					.values({
						businessId: loaded.biz.id,
						name,
						phoneE164: phoneDigitsBr(phone),
						origin: "public_link",
					})
					.returning()
			)[0];
			/* v8 ignore next 2 -- .returning() de insert válido nunca retorna vazio */
			if (!client) return c.json({ error: "falha ao registrar cliente" }, 500);
		}

		const [created] = await db
			.insert(appointments)
			.values({
				businessId: loaded.biz.id,
				clientId: client.id,
				serviceId: svc.id,
				userId: loaded.pro.id,
				startsAt: start,
				endsAt: end,
				bufferMin,
				status: "pending",
				source: "public_link",
				// 0026: veio pelo link de um agregador
				aggregatorBusinessId: loaded.aggregator?.id ?? null,
			})
			.returning();

		/* v8 ignore next 2 -- .returning() de insert válido nunca retorna vazio */
		if (!created) return c.json({ error: "falha ao criar agendamento" }, 500);

		// Push pro prestador (best-effort, fora do caminho da response): novo
		// booking pelo link público = cliente novo na agenda dele.
		const when = start.toLocaleString("pt-BR", {
			day: "2-digit",
			month: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			// fuso do NEGÓCIO — o servidor roda em UTC em produção
			timeZone: loaded.biz.timezone,
		});
		// guarda na central (sino) + push — notify nunca lança
		void notify(databaseUrl, {
			userId: loaded.pro.id,
			type: "new_booking",
			title: "Novo agendamento",
			body: `${client.name} — ${svc.name} em ${when}`,
			data: {
				appointment_id: created.id,
				starts_at: created.startsAt.toISOString(),
			},
		});

		// D3: agregador fica sabendo (sem dados do cliente)
		if (loaded.aggregator) {
			void notify(databaseUrl, {
				userId: page.owner.id,
				type: "aggregator_booking",
				title: "Novo agendamento pelo seu link",
				body: `${proLabel(loaded.pro.name, loaded.biz.name)} — ${svc.name} em ${when}`,
				data: { starts_at: created.startsAt.toISOString() },
			});
		}

		return c.json(
			{
				id: created.id,
				status: created.status,
				starts_at: created.startsAt,
				ends_at: created.endsAt,
				service: svc.name,
				business: page.biz.name,
				professional: isAggregator(page)
					? proLabel(loaded.pro.name, loaded.biz.name)
					: loaded.pro.name,
			},
			201,
		);
	});

	// ---- intervalos ocupados do dia (pro filtro de slots client-side)
	routes.get("/p/:slug/busy", async (c) => {
		const slug = c.req.param("slug");
		const page = await loadPage(db, slug);
		if (!page) return c.json({ error: "link não encontrado" }, 404);
		const loaded = await resolveTarget(db, page, c.req.query("professional"));
		if ("error" in loaded) {
			return c.json({ error: loaded.error }, loaded.status);
		}

		const dateStr = c.req.query("date") ?? "";
		const dayStart = new Date(`${dateStr}T00:00:00`);
		if (Number.isNaN(dayStart.getTime())) {
			return c.json({ error: "Data inválida" }, 400);
		}
		const dayEnd = new Date(dayStart.getTime() + 86_400_000);

		// F3: bloqueios de agenda contam como ocupados pro cliente
		const timeOffs = await db
			.select({
				startsAt: timeOffsTable.startsAt,
				endsAt: timeOffsTable.endsAt,
			})
			.from(timeOffsTable)
			.where(
				and(
					eq(timeOffsTable.userId, loaded.pro.id),
					lt(timeOffsTable.startsAt, dayEnd),
					gt(timeOffsTable.endsAt, dayStart),
				),
			);

		const rows = await db
			.select({
				startsAt: appointments.startsAt,
				endsAt: appointments.endsAt,
				bufferMin: appointments.bufferMin,
			})
			.from(appointments)
			.where(
				and(
					eq(appointments.businessId, loaded.biz.id),
					eq(appointments.userId, loaded.pro.id),
					gte(appointments.startsAt, dayStart),
					lte(appointments.startsAt, dayEnd),
					sql`${appointments.status} IN ('pending', 'confirmed')`,
				),
			);
		return c.json({
			busy: [
				// end inclui a folga do agendamento (período em que o
				// profissional não pode começar outro atendimento)
				...rows.map((r) => ({
					start: r.startsAt.toISOString(),
					end: occupiedEnd(r.endsAt, r.bufferMin).toISOString(),
				})),
				// bloqueios vão com flag pra o cliente ver "indisponível"
				...timeOffs.map((t) => ({
					start: t.startsAt.toISOString(),
					end: t.endsAt.toISOString(),
					blocked: true,
				})),
			],
		});
	});

	// ---- convite .ics pra o cliente salvar no calendário do celular dele
	// (lembrete de graça via Google Calendar que o cliente já usa)
	routes.get("/p/:slug/ics/:appointmentId", async (c) => {
		const slug = c.req.param("slug");
		const loaded = await loadBySlug(db, slug);
		if (!loaded) return c.json({ error: "link não encontrado" }, 404);
		const bizId = loaded.biz.id;
		const apptId = c.req.param("appointmentId");
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				apptId,
			)
		) {
			return c.json({ error: "Registro inválido" }, 400);
		}
		const appt = (
			await db
				.select()
				.from(appointments)
				.where(
					and(
						eq(appointments.id, apptId),
						// 0026: no link do agregador o agendamento mora no
						// business do profissional — vale pela origem
						or(
							eq(appointments.businessId, bizId),
							eq(appointments.aggregatorBusinessId, bizId),
						),
					),
				)
				.limit(1)
		)[0];
		if (!appt) return c.json({ error: "agendamento não encontrado" }, 404);
		const svc = (
			await db
				.select({ name: services.name })
				.from(services)
				.where(eq(services.id, appt.serviceId))
				.limit(1)
		)[0];
		// profissional do agendamento (no agregador, não é o dono do link)
		const pro = (
			await db
				.select({ name: users.name, bizName: businesses.name })
				.from(users)
				.innerJoin(businesses, eq(businesses.id, users.businessId))
				.where(eq(users.id, appt.userId))
				.limit(1)
		)[0];
		/* v8 ignore next 4 -- fallback defensivo: FK appointments→users garante a linha */
		const proName = !pro
			? loaded.pro.name
			: appt.aggregatorBusinessId === loaded.biz.id
				? proLabel(pro.name, pro.bizName) // veio pelo agregador
				: pro.name;

		const fmt = (d: Date) =>
			d.toISOString().replace(/[-:]/g, "").replace(/\.000/, "");
		/* v8 ignore next 3 -- inatingível: FK appointments→services garante
		   a linha; guard defensivo */
		if (!svc) return c.json({ error: "serviço não encontrado" }, 404);
		const summary = `${svc.name} com ${loaded.biz.name}`;
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//AGENVA//PT-BR",
			"BEGIN:VEVENT",
			`UID:${appt.id}`,
			`DTSTAMP:${fmt(new Date())}`,
			`DTSTART:${fmt(appt.startsAt)}`,
			`DTEND:${fmt(appt.endsAt)}`,
			`SUMMARY:${summary}`,
			`DESCRIPTION:Agendamento com ${proName} — ${loaded.biz.name}`,
			"BEGIN:VALARM",
			"TRIGGER:-PT2H",
			"ACTION:DISPLAY",
			"DESCRIPTION:Lembrete de horário",
			"END:VALARM",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");

		c.header("Content-Type", "text/calendar; charset=utf-8");
		c.header(
			"Content-Disposition",
			`attachment; filename="horario-${appt.id.slice(0, 8)}.ics"`,
		);
		return c.body(ics);
	});

	// ---- HTML da página pública (última, pra não engolir as rotas acima)
	routes.get("/p/:slug", async (c) => {
		const slug = c.req.param("slug");
		c.header("Cache-Control", "no-store, max-age=0");
		// Paleta do SEGMENTO (default = marca AGENVA) — load barato 1x/página
		const loaded = await loadBySlug(db, slug);
		// B8: OG tags + favicon com a logo real — preview do WhatsApp/Telegram
		// mostra o nome e a logo do negócio (bug reportado por Rafael 18/09).
		let bizName: string | null = null;
		let hasLogo = false;
		if (loaded) {
			bizName = loaded.biz.name;
			const [logo] = await db
				.select({ mime: businesses.logoMime })
				.from(businesses)
				.where(eq(businesses.id, loaded.biz.id))
				.limit(1);
			hasLogo = Boolean(logo?.mime);
		}
		// og:image/og:url exigem URL ABSOLUTA (crawler do WhatsApp não resolve
		// caminho relativo — pitfall B8). Origem vem do próprio request.
		const origin = new URL(c.req.url).origin;
		return c.html(
			publicPageHtml(slug, origin, loaded?.biz.businessType, bizName, hasLogo),
		);
	});

	// ---- RF-B02..B04: confirmação de presença do cliente (link do WhatsApp)
	// Sem auth: token HMAC(appointmentId+startsAt). Idempotente por design.
	type ConfirmCtx = {
		loaded: NonNullable<Loaded>;
		appt: typeof appointments.$inferSelect;
	};

	/** Carrega negócio + agendamento e valida o token (RF-B03: nada muda). */
	async function loadConfirm(
		slug: string,
		appointmentId: string,
		token: string,
	): Promise<ConfirmCtx | { failure: 403 | 404; business?: string }> {
		const loaded = await loadBySlug(db, slug);
		if (!loaded || !isUuid(appointmentId)) {
			return { failure: 404, business: loaded?.biz.name };
		}
		const [appt] = await db
			.select()
			.from(appointments)
			.where(
				and(
					eq(appointments.id, appointmentId),
					eq(appointments.businessId, loaded.biz.id),
				),
			)
			.limit(1);
		if (!appt) return { failure: 404, business: loaded.biz.name };
		if (!verifyConfirmationToken(appointmentId, appt.startsAt, token)) {
			return { failure: 403, business: loaded.biz.name };
		}
		return { loaded, appt };
	}

	/** RF-B04: só pending muda (e só 1 vez: confirmar 2x não repete o aviso). */
	async function applyDecision(
		{ loaded, appt }: ConfirmCtx,
		decide: "confirm" | "cancel",
	): Promise<void> {
		const patch: {
			status: "confirmed" | "canceled";
			canceledAt?: Date;
			canceledReason?: string;
		} =
			decide === "confirm"
				? { status: "confirmed" }
				: {
						status: "canceled",
						canceledAt: new Date(),
						canceledReason: "cliente cancelou via link",
					};
		const changed = await db
			.update(appointments)
			.set(patch)
			.where(
				and(eq(appointments.id, appt.id), eq(appointments.status, "pending")),
			)
			.returning({ id: appointments.id });
		if (changed.length === 0) return;

		// push pro prestador (best-effort, igual ao novo agendamento)
		const when = new Date(appt.startsAt).toLocaleString("pt-BR", {
			day: "2-digit",
			month: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			// fuso do NEGÓCIO — o servidor roda em UTC em produção
			timeZone: loaded.biz.timezone,
		});
		const [client] = await db
			.select({ name: clients.name })
			.from(clients)
			.where(eq(clients.id, appt.clientId))
			.limit(1);
		/* v8 ignore next -- client sempre existe via FK; ?? é defesa */
		const clientName = client?.name ?? "Cliente";
		void notify(databaseUrl, {
			userId: loaded.pro.id,
			type: decide === "confirm" ? "client_confirmed" : "client_canceled",
			title:
				decide === "confirm" ? "✅ Confirmação de presença" : "❌ Cancelamento",
			body:
				decide === "confirm"
					? `${clientName} confirmou presença em ${when}.`
					: `${clientName} não vai poder em ${when}. Horário vagou!`,
			data: {
				appointment_id: appt.id,
				starts_at: new Date(appt.startsAt).toISOString(),
			},
		});
	}

	// Sem decide = o link que vai no WhatsApp: abre a página com os botões.
	// A pré-visualização do WhatsApp também faz este GET, por isso ele não
	// altera nada; quem decide é o POST dos botões.
	routes.get("/p/:slug/confirm/:appointmentId", async (c) => {
		const slug = c.req.param("slug");
		const appointmentId = c.req.param("appointmentId");
		const token = c.req.query("token") ?? "";
		const decide = c.req.query("decide");

		if (decide === undefined) {
			const ctx = await loadConfirm(slug, appointmentId, token);
			if ("failure" in ctx) {
				return c.html(
					confirmFailureHtml(ctx.failure, ctx.business),
					ctx.failure,
				);
			}
			// FKs garantem as duas linhas do join
			const row = (
				await db
					.select({ service: services.name, client: clients.name })
					.from(appointments)
					.innerJoin(services, eq(services.id, appointments.serviceId))
					.innerJoin(clients, eq(clients.id, appointments.clientId))
					.where(eq(appointments.id, appointmentId))
					.limit(1)
			)[0] as { service: string; client: string };
			return c.html(
				confirmPageHtml({
					slug,
					appointmentId,
					token,
					business: ctx.loaded.biz.name,
					businessType: ctx.loaded.biz.businessType,
					timeZone: ctx.loaded.biz.timezone,
					status: ctx.appt.status,
					startsAt: ctx.appt.startsAt,
					service: row.service,
					client: row.client,
				}),
			);
		}

		if (decide !== "confirm" && decide !== "cancel") {
			return c.json({ error: "Resposta inválida" }, 400);
		}
		const ctx = await loadConfirm(slug, appointmentId, token);
		if ("failure" in ctx) {
			return ctx.failure === 403
				? c.json({ error: "Link inválido" }, 403)
				: c.json({ error: "agendamento não encontrado" }, 404);
		}
		await applyDecision(ctx, decide);
		return c.json({
			status: decide === "confirm" ? "confirmed" : "canceled",
			message:
				decide === "confirm"
					? "Presença confirmada! Esperamos você."
					: "Tudo certo, horário liberado.",
		});
	});

	// Botões da página: aplica e volta pro GET, que mostra a situação real.
	routes.post("/p/:slug/confirm/:appointmentId", async (c) => {
		const slug = c.req.param("slug");
		const appointmentId = c.req.param("appointmentId");
		const token = c.req.query("token") ?? "";
		const decide = c.req.query("decide");
		const ctx = await loadConfirm(slug, appointmentId, token);
		if ("failure" in ctx) {
			return c.html(confirmFailureHtml(ctx.failure, ctx.business), ctx.failure);
		}
		// horário que já passou não muda mais (a página nem mostra os botões)
		if (
			(decide === "confirm" || decide === "cancel") &&
			ctx.appt.startsAt.getTime() > Date.now()
		) {
			await applyDecision(ctx, decide);
		}
		return c.redirect(
			`/p/${slug}/confirm/${appointmentId}?token=${encodeURIComponent(token)}`,
			303,
		);
	});

	return routes;
}

/** Página standalone: zero build, CSS/JS inline, mobile-first. */
// ---- Paleta por segmento (espelho dos presets do app Flutter).
// Default = identidade da MARCA AGENVA (DESIGN.md v2); cor do SEGMENTO
// vence quando o business tem tipo conhecido (decisão multi-segmento).
const SEGMENT_PALETTES: Record<string, { p: string; selBg: string }> = {
	beauty: { p: "#B51F4D", selBg: "#FDF0F4" },
	barber: { p: "#8B5E34", selBg: "#F3EDE5" },
	dental: { p: "#1976D2", selBg: "#E8F1FB" },
	medical: { p: "#00897B", selBg: "#E4F3F1" },
	auto_detailing: { p: "#37474F", selBg: "#EDF1F3" },
	pet_grooming: { p: "#F57C00", selBg: "#FEF2E4" },
	veterinary: { p: "#2E7D32", selBg: "#E9F3EA" },
	mechanic: { p: "#455A64", selBg: "#EDF1F3" },
	other: { p: "#5E35B1", selBg: "#F0EAF9" },
};
const BRAND_PALETTE = { p: "#1E96E8", selBg: "#E8F3FC" }; // marca AGENVA

const htmlEsc = (v: string) =>
	v.replace(
		/[&<>"']/g,
		(ch) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				ch
			] as string,
	);

/** Casca das páginas de confirmação (mesmo visual do link de agendamento). */
function confirmShell(title: string, body: string, businessType?: string) {
	const pal = (businessType && SEGMENT_PALETTES[businessType]) || BRAND_PALETTE;
	return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<meta property="og:title" content="${title}">
<style>
:root{--p:${pal.p};--bg:#FAF7F5;--tx:#2B2226;--mut:#8A7B81}
*{box-sizing:border-box;margin:0}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--tx);padding:20px;max-width:520px;margin:0 auto}
.card{background:#fff;border-radius:14px;padding:24px 18px;margin:14px 0;box-shadow:0 1px 4px rgba(0,0,0,.06);text-align:center}
.big{font-size:3rem}
h1{font-size:1.35rem;margin:8px 0}
.mut{color:var(--mut);font-size:.95rem;margin-top:8px}
.when{font-weight:700;margin-top:12px}
form{margin-top:12px}
button,a.btn{display:block;width:100%;padding:14px;border-radius:12px;font-size:1rem;font-weight:700;cursor:pointer;text-decoration:none;text-align:center}
button.yes{border:0;background:var(--p);color:#fff}
button.no,a.btn{background:#fff;color:var(--p);border:1.5px solid var(--p)}
a.btn{margin-top:16px}
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

/** Link sem validade: token errado, horário remarcado ou agendamento sumiu. */
function confirmFailureHtml(status: 403 | 404, business?: string) {
	const who = business ? htmlEsc(business) : "o estabelecimento";
	return confirmShell(
		"Link indisponível",
		`<div class="big">🔗</div>
<h1>${status === 403 ? "Este link não vale mais" : "Agendamento não encontrado"}</h1>
<p class="mut">${
			status === 403
				? "O horário pode ter mudado depois que o link foi enviado."
				: "Ele pode ter sido removido."
		} Fale com ${who} para receber um link novo.</p>`,
	);
}

/** Página do link do WhatsApp: botões enquanto pendente, senão a situação. */
function confirmPageHtml(p: {
	slug: string;
	appointmentId: string;
	token: string;
	business: string;
	businessType: string;
	timeZone: string;
	status: string;
	startsAt: Date;
	service: string;
	client: string;
}) {
	const when = p.startsAt.toLocaleString("pt-BR", {
		weekday: "long",
		day: "2-digit",
		month: "long",
		hour: "2-digit",
		minute: "2-digit",
		timeZone: p.timeZone,
	});
	const business = htmlEsc(p.business);
	const details = `<p class="mut">${htmlEsc(p.service)} em ${business}</p>
<p class="when">${htmlEsc(when)}</p>`;
	const past = p.startsAt.getTime() <= Date.now();
	const base = `/p/${encodeURIComponent(p.slug)}/confirm/${p.appointmentId}?token=${encodeURIComponent(p.token)}`;
	const firstName = p.client.trim().split(/\s+/)[0];
	let body: string;
	if (p.status === "canceled") {
		body = `<div class="big">❌</div><h1>Agendamento cancelado</h1>${details}
<p class="mut">Este horário não está mais reservado.</p>
<a class="btn" href="/p/${encodeURIComponent(p.slug)}">Agendar outro horário</a>`;
	} else if (past || p.status === "done" || p.status === "noshow") {
		body = `<div class="big">⌛</div><h1>Esse horário já passou</h1>${details}
<a class="btn" href="/p/${encodeURIComponent(p.slug)}">Agendar outro horário</a>`;
	} else if (p.status === "confirmed") {
		body = `<div class="big">✅</div><h1>Presença confirmada!</h1>${details}
<p class="mut">Esperamos você. Se precisar desmarcar, fale com ${business}.</p>`;
	} else {
		body = `<div class="big">👋</div><h1>Olá${firstName ? `, ${htmlEsc(firstName)}` : ""}! Você vem?</h1>${details}
<form method="post" action="${base}&amp;decide=confirm"><button class="yes" type="submit">Vou comparecer</button></form>
<form method="post" action="${base}&amp;decide=cancel"><button class="no" type="submit">Não vou poder</button></form>`;
	}
	return confirmShell(
		`Confirme seu horário — ${business}`,
		body,
		p.businessType,
	);
}

function publicPageHtml(
	slug: string,
	origin: string,
	bizType?: string | null,
	bizName?: string | null,
	hasLogo?: boolean,
): string {
	const esc = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
	const s = esc(slug);
	const pal = (bizType && SEGMENT_PALETTES[bizType]) || BRAND_PALETTE;
	// B8: OG tags — preview de WhatsApp/Telegram mostra nome + logo do negócio
	const title = esc(bizName ? `${bizName} — Agende online` : "Agende online");
	const description = esc(
		bizName ? `Marque seu horário em ${bizName}` : "Marque seu horário online",
	);
	const base = origin;
	const logoUrl = hasLogo ? `${base}/v1/businesses/${s}/logo` : "";
	const pageUrl = `${base}/p/${s}`;
	const ogTags = `
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${pageUrl}">
${hasLogo ? `<meta property="og:image" content="${logoUrl}">\n<link rel="icon" href="${logoUrl}">` : ""}`;
	return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>${ogTags}
<style>
:root{--p:#B51F4D;--bg:#FAF7F5;--tx:#2B2226;--mut:#8A7B81}
*{box-sizing:border-box;margin:0}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--tx);padding:20px;max-width:520px;margin:0 auto}
h1{font-size:1.4rem;margin:8px 0 2px}
.mut{color:var(--mut);font-size:.9rem}
.card{background:#fff;border-radius:14px;padding:16px;margin:14px 0;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.svc{display:flex;justify-content:space-between;align-items:center;padding:12px;border:1.5px solid #eee;border-radius:10px;margin:8px 0;cursor:pointer}
.svc.sel{border-color:var(--p);background:var(--selBg)}
.avatar{display:inline-flex;width:36px;height:36px;border-radius:50%;align-items:center;justify-content:center;background:var(--selBg);color:var(--p);font-weight:700}
label{display:block;font-size:.85rem;font-weight:600;margin:12px 0 4px}
input{width:100%;padding:12px;border:1.5px solid #ddd;border-radius:10px;font-size:1rem}
button{width:100%;padding:14px;border:0;border-radius:12px;background:var(--p);color:#fff;font-size:1rem;font-weight:700;margin-top:16px;cursor:pointer}
button:disabled{opacity:.5}
.err{background:#FDECEC;color:#8B1E33;padding:10px;border-radius:10px;margin:10px 0;font-size:.9rem;display:none}
.ok{text-align:center;padding:30px 10px}
.ics-btn{display:inline-block;padding:12px 18px;background:#fff;border:2px solid var(--p);color:var(--p);border-radius:12px;text-decoration:none;font-weight:700}
.ics-btn.gcal{border-color:#1a73e8;color:#1a73e8}
.ok .big{font-size:3rem}
.slots{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.slot{padding:10px 12px;border:1.5px solid #ddd;border-radius:10px;cursor:pointer;font-size:.9rem}
.slot.sel{border-color:var(--p);background:var(--selBg);font-weight:700}
.slot.off{opacity:.35;text-decoration:line-through;cursor:not-allowed;pointer-events:none}
button.sec{background:#fff;color:var(--p);border:1.5px solid var(--p);margin-top:10px;font-weight:600}
</style>
</head>
<body>
<div id="app"><h1>Carregando…</h1></div>
<script>
const SLUG = "${s}";
// Máscara de telefone BR enquanto digita (a API guarda só os dígitos).
// Teste em test/routes/public-booking.test.ts extrai e roda esta função.
function maskPhone(v){
  let d = String(v).replace(/\\D/g,'');
  // colou com DDI (+55 11 9...): tira o 55; com 11 dígitos 55 é DDD (RS)
  if(d.length > 11 && d.startsWith('55')) d = d.slice(2);
  d = d.slice(0,11);
  if(d.length <= 2) return d.length ? '('+d : '';
  if(d.length <= 6) return '('+d.slice(0,2)+') '+d.slice(2);
  if(d.length <= 10) return '('+d.slice(0,2)+') '+d.slice(2,6)+'-'+d.slice(6);
  return '('+d.slice(0,2)+') '+d.slice(2,7)+'-'+d.slice(7);
}
// nomes vêm do cadastro do prestador: escapa antes de pôr no HTML
const esc = v => String(v).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
// B1: cópia JS de slotStillValid (src/domain/public-booking-ui.ts) — o HTML
// não importa módulos. Teste de paridade em test/routes/public-booking.test.ts
// extrai isto do HTML servido e compara com a função pura: drift quebra CI.
function slotStillValid(picked, day, durationMin, workingHours, busy, now, bufferMin){
  if(picked.getTime() <= now.getTime()) return false;
  const wd = day.getDay();
  const h = workingHours.find(x=>x.weekday===wd);
  if(!h) return false;
  const parts = h.start_time.split(':').map(Number); const sh = parts[0]||0, sm = parts[1]||0;
  const eh = Number(h.end_time.split(':')[0])||0;
  const openMin = sh*60+sm, closeMin = eh*60;
  const startMin = picked.getHours()*60+picked.getMinutes();
  if(startMin < openMin || startMin+durationMin > closeMin) return false;
  const startMs = picked.getTime(), endMs = startMs + (durationMin+(bufferMin||0))*60000;
  return !busy.some(b => startMs < new Date(b.end).getTime() && endMs > new Date(b.start).getTime());
}
document.documentElement.style.setProperty('--p', "${pal.p}");
document.documentElement.style.setProperty('--selBg', "${pal.selBg}");
const app = document.getElementById('app');
// SEL = ids escolhidos (vários serviços num horário só; kit vai sozinho)
let INFO = null, SEL = [], DAY = null;
// 0026: link de agregador — seletor de profissional (PROS) e o escolhido (PRO)
let PROS = null, PRO = null;
const proQs = () => PRO ? '&professional='+encodeURIComponent(PRO) : '';
const selSvcs = () => SEL.map(id => INFO.services.find(x=>x.id===id)).filter(Boolean);
const selDur = () => selSvcs().reduce((a,s)=>a+s.duration_min,0) || 30;

init();
// troca de profissional: recarrega catálogo/horários DELE e limpa escolhas
window.pickPro = async id => {
  PRO = id; SEL = []; window.PICKED = null; PICKED_KEEP = false;
  try{
    const r = await fetch('/p/'+SLUG+'/info?professional='+encodeURIComponent(id));
    if(!r.ok) throw 0;
    INFO = await r.json();
  }catch(e){ PRO = null; return renderForm('não consegui abrir a agenda desse profissional, tente de novo'); }
  renderForm();
};

async function init(){
  try{
    const r = await fetch('/p/'+SLUG+'/info');
    if(!r.ok) throw 0;
    INFO = await r.json();
    if(INFO.professionals){
      PROS = INFO.professionals;
      if(PROS.length===0){
        app.innerHTML = \`<div class="card"><h1>\${esc(INFO.business.name)}</h1><p class="mut">Nenhum profissional com agenda aberta neste link no momento. Tente mais tarde.</p></div>\`;
        return;
      }
      // um só profissional: já entra na agenda dele
      if(PROS.length===1) return pickPro(PROS[0].id);
    }
    renderForm();
  }catch(e){
    app.innerHTML = '<div class="card"><h1>Link inválido</h1><p class="mut">Essa agenda não existe ou foi removida.</p></div>';
  }
}

function brl(c){return (c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}

// link "Adicionar ao Google Calendar" — URL TEMPLATE, sem OAuth nem API
function gcalUrl(appt){
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: \`\${appt.service} em \${appt.business}\`,
    dates: \`\${toGcalDate(new Date(appt.starts_at))}/\${toGcalDate(new Date(appt.ends_at))}\`,
    details: 'Agendamento feito pelo link do AGENVA'
  });
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}
function toGcalDate(d){
  return d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0') + 'T' + String(d.getHours()).padStart(2,'0') + String(d.getMinutes()).padStart(2,'0') + '00';
}

// snapshot do que o usuário já digitou (sobrevive a re-render de erro)
let NAME_DRAFT = '', PHONE_DRAFT = '';

function renderForm(msg){
  const days = [];
  for(let i=0;i<14;i++){
    const d = new Date(); d.setDate(d.getDate()+i);
    days.push(d);
  }
  app.innerHTML = \`
    <h1>\${INFO.business.name}</h1>
    <p class="mut">\${PROS ? (PRO ? 'com '+esc(INFO.professional.name)+' · ' : '') : 'com '+INFO.professional.name+' · '}agende seu horário</p>
    \${INFO.business.address && INFO.business.address.street ? \`
    <p class="mut" id="biz-address">📍 \${[
      INFO.business.address.street,
      INFO.business.address.number,
      INFO.business.address.district,
      INFO.business.address.city,
      INFO.business.address.state
    ].filter(Boolean).join(', ')}\${INFO.business.address.zip ? ' · CEP ' + INFO.business.address.zip : ''}</p>\` : ''}
    <div class="err" id="err"></div>
    <div class="card">
      <label>1. Seus dados</label>
      <input id="nm" placeholder="Seu nome" value="\${NAME_DRAFT}">
      <input id="ph" placeholder="WhatsApp (com DDD)" inputmode="tel" style="margin-top:8px" value="\${PHONE_DRAFT}">
      \${PROS ? \`<label>2. Escolha o profissional</label>
      \${PROS.map(p=>\`<div class="svc pro\${PRO===p.id?' sel':''}" onclick="pickPro('\${p.id}')">
        <span style="display:flex;align-items:center;gap:10px">\${p.logo_url?'<img src="'+p.logo_url+'" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover">':'<span class="avatar">'+esc(p.name.charAt(0).toUpperCase())+'</span>'}\${esc(p.name)}</span></div>\`).join('')}\` : ''}
      \${PROS && !PRO ? '' : \`
      <label>\${PROS?3:2}. Escolha o(s) serviço(s)</label>
      <p class="mut" style="margin:0 0 4px">Pode marcar mais de um — todos ficam no mesmo horário.</p>
      \${INFO.services.map(s=>\`<div class="svc\${SEL.includes(s.id)?' sel':''}" onclick="pick('\${s.id}')">
        <span>\${esc(s.name)} · \${s.duration_min}min\${s.items&&s.items.length?'<br><small class="mut">Kit: '+s.items.map(esc).join(' + ')+'</small>':''}</span><b>\${s.items_total_cents>s.price_cents?'<s class="mut">'+brl(s.items_total_cents)+'</s> ':''}\${brl(s.price_cents)}</b></div>\`).join('')}
      \${SEL.length>1?\`<p id="sel-total"><b>\${SEL.length} serviços · \${selDur()} min · \${brl(selSvcs().reduce((a,s)=>a+s.price_cents,0))}</b></p>\`:''}
      <label>\${PROS?4:3}. Escolha o dia</label>
      <div class="slots" id="days"></div>
      <label>\${PROS?5:4}. Horários livres (\${DAY?DAY.toLocaleDateString('pt-BR'):'—'})</label>
      <div class="slots" id="slots"><span class="mut">escolha um dia acima</span></div>
      <button id="go" onclick="book()">Confirmar agendamento</button>
      <button id="wl" class="sec" onclick="joinWaitlist()">\${wlLabel()}</button>\`}
    </div>\`;
  // mantém o que estava digitado a cada re-render
  const nm = document.getElementById('nm');
  const ph = document.getElementById('ph');
  nm.addEventListener('input', () => { NAME_DRAFT = nm.value; });
  // máscara do WhatsApp: (11) 98765-4321 / (11) 3456-7890
  ph.addEventListener('input', () => { ph.value = maskPhone(ph.value); PHONE_DRAFT = ph.value; });
  if(msg){ const e=document.getElementById('err'); e.textContent=msg; e.style.display='block'; }
  // agregador sem profissional escolhido: ainda não há dias/horários
  if(PROS && !PRO) return;

  const dw = document.getElementById('days');
  days.forEach(d=>{
    const el = document.createElement('div');
    el.className='slot';
    if(DAY && d.toDateString()===DAY.toDateString()) el.classList.add('sel');
    el.textContent = d.toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit',month:'2-digit'});
    el.onclick = ()=>{ DAY=d; window.PICKED=null; [...dw.children].forEach(x=>x.classList.remove('sel')); el.classList.add('sel'); loadSlots(); };
    dw.appendChild(el);
  });
  if(DAY) loadSlots(PICKED_KEEP);
}
// Re-render de erro NÃO perde o horário escolhido. Ao trocar serviço, a
// lista recalcula conflitos/duração do NOVO serviço e só limpa se o slot cair.
let PICKED_KEEP = false;
// avulso: marca/desmarca (vários); kit: vai sozinho (não soma com outros)
window.pick = id => {
  const s = INFO.services.find(x=>x.id===id);
  const isKit = x => x && x.items && x.items.length;
  if(isKit(s)){ SEL = SEL.includes(id) ? [] : [id]; }
  else {
    SEL = SEL.filter(x => !isKit(INFO.services.find(y=>y.id===x)));
    SEL = SEL.includes(id) ? SEL.filter(x=>x!==id) : [...SEL, id];
  }
  PICKED_KEEP=!!window.PICKED; renderForm();
};

// rótulo do botão da lista de espera (segue o dia escolhido)
function wlLabel(){
  return '⏳ Não achou horário? Entrar na lista de espera'+(DAY?' de '+DAY.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}):'');
}

async function loadSlots(keepPicked){
  const wl = document.getElementById('wl');
  if(wl) wl.textContent = wlLabel();
  // slots de 10min entre abrir/fechar do dia, já filtrando ocupados pela
  // duração do serviço escolhido + folga do negócio (GET /p/:slug/busy)
  const slots = document.getElementById('slots');
  slots.innerHTML = '<span class="mut">carregando…</span>';
  const wd = DAY.getDay();
  const h = INFO.working_hours.find(x=>x.weekday===wd);
  if(!h){ slots.innerHTML='<span class="mut">fechado neste dia</span>'; return; }
  const [sh,sm] = h.start_time.split(':').map(Number);
  const [eh] = h.end_time.split(':').map(Number);
  const out=[];
  for(let m=sh*60+sm; m<eh*60; m+=10){
    const d = new Date(DAY); d.setHours(Math.floor(m/60), m%60, 0, 0);
    if(d > new Date()) out.push(d);
  }
  // duração somada dos serviços escolhidos (fallback 30min sem escolha)
  const dur = selDur() * 60000;
  const buf = (INFO.business.buffer_min||0) * 60000;
  let busy = [];
  try{
    const ds = DAY.getFullYear()+'-'+String(DAY.getMonth()+1).padStart(2,'0')+'-'+String(DAY.getDate()).padStart(2,'0');
    const r = await fetch('/p/'+SLUG+'/busy?date='+ds+proQs());
    if(r.ok){ busy = (await r.json()).busy; }
  }catch(e){}
  const conflicts = d => busy.some(b =>
    d.getTime() < new Date(b.end).getTime() &&
    d.getTime()+dur+buf > new Date(b.start).getTime());
  slots.innerHTML='';
  out.forEach(d=>{
    const el=document.createElement('div'); el.className='slot';
    el.textContent=d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    if(conflicts(d)) el.classList.add('off');
    const isPicked = window.PICKED && d.getTime()===window.PICKED.getTime();
    if(isPicked && keepPicked && !el.classList.contains('off')) el.classList.add('sel');
    el.onclick=()=>{
      if(el.classList.contains('off')) return;
      window.PICKED=d; [...slots.children].forEach(x=>x.classList.remove('sel')); el.classList.add('sel');
    };
    slots.appendChild(el);
  });
  // slot escolhido virou indisponível (trocou serviço / foi ocupado)
  if(window.PICKED){
    const still = slotStillValid(window.PICKED, DAY, selDur(), INFO.working_hours, busy, new Date(), INFO.business.buffer_min||0);
    if(!still){
      window.PICKED = null;
      const err=document.getElementById('err');
      err.textContent='o horário escolhido não está disponível para este serviço — escolha outro';
      err.style.display='block';
    }
  }
  if(out.length>0 && out.every(d=>conflicts(d))){
    slots.innerHTML='<span class="mut">sem horários livres para este serviço neste dia — escolha outro dia ou serviço</span>';
  }
}

// Lista de espera do dia escolhido: usa o nome/WhatsApp já digitados.
async function joinWaitlist(){
  const nm=document.getElementById('nm').value.trim();
  const ph=document.getElementById('ph').value.trim();
  const e=document.getElementById('err');
  const fail = m => { e.textContent=m; e.style.display='block'; };
  if(!nm) return fail('Informe seu nome para entrar na lista de espera');
  if(ph.replace(/\\D/g,'').length<10) return fail('Informe seu WhatsApp com DDD para entrar na lista de espera');
  if(!DAY) return fail('Escolha o dia em que você quer a vaga');
  const ds = DAY.getFullYear()+'-'+String(DAY.getMonth()+1).padStart(2,'0')+'-'+String(DAY.getDate()).padStart(2,'0');
  const btn=document.getElementById('wl'); btn.disabled=true;
  try{
    const r = await fetch('/v1/p/'+SLUG+'/waitlist',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(Object.assign({ name:nm, phone:ph, desired_date:ds }, PRO ? { professional_id: PRO } : {}))
    });
    const d = await r.json();
    if(!r.ok){ btn.disabled=false; return fail(d.error||'Não foi possível entrar na lista agora'); }
    const dia = DAY.toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'2-digit'});
    app.innerHTML = \`<div class="ok card"><div class="big">⏳</div>
      <h1>Você está na lista de espera!</h1>
      <p style="margin-top:10px;font-weight:700">\${esc(dia)}</p>
      <p class="mut" style="margin-top:10px">Se abrir um horário nesse dia, \${esc(INFO.business.name)} avisa você pelo WhatsApp \${esc(ph)}.</p>
      <button class="sec" onclick="renderForm()">Voltar para a agenda</button></div>\`;
  }catch(err){
    btn.disabled=false;
    fail('sem conexão, tente novamente');
  }
}

async function book(){
  const nm=document.getElementById('nm').value.trim();
  const ph=document.getElementById('ph').value.trim();
  const e=document.getElementById('err');
  if(!SEL.length){ e.textContent='escolha um serviço'; e.style.display='block'; return; }
  if(!window.PICKED){ e.textContent='escolha um horário'; e.style.display='block'; return; }
  const btn=document.getElementById('go'); btn.disabled=true;
  try{
    const r = await fetch('/p/'+SLUG+'/book',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(Object.assign({ name:nm, phone:ph, starts_at:window.PICKED.toISOString() },
        SEL.length>1 ? { service_ids: SEL } : { service_id: SEL[0] },
        PRO ? { professional_id: PRO } : {}))
    });
    const d = await r.json();
    if(!r.ok){
      btn.disabled=false;
      const e=document.getElementById('err');
      e.textContent = d.error||'erro';
      e.style.display='block';
      // conflito/ocupado: o slot escolhido acabou de ser tomado → recarrega
      // os horários do dia (mantém nome/telefone/serviço preenchidos)
      if(r.status===409 && DAY){ window.PICKED=null; PICKED_KEEP=false; loadSlots(); }
      return;
    }
    const when = new Date(d.starts_at).toLocaleString('pt-BR',{weekday:'long',day:'2-digit',month:'long',hour:'2-digit',minute:'2-digit'});
    app.innerHTML = \`<div class="ok card"><div class="big">✅</div>
      <h1>Horário agendado!</h1>
      <p class="mut">\${d.service}\${PROS && d.professional ? ' com '+esc(d.professional) : ''} em \${d.business}</p>
      <p style="margin-top:10px;font-weight:700">\${when}</p>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:18px;flex-wrap:wrap">
        <a class="ics-btn" href="/p/\${SLUG}/ics/\${d.id}">📅 Salvar no meu celular</a>
        <a class="ics-btn gcal" target="_blank" href="\${gcalUrl(d)}">🗓️ Adicionar ao Google Calendar</a>
      </div>
      <p class="mut" style="margin-top:10px">Toque acima para o seu celular lembrar você do horário. Esperamos você! 😉</p></div>\`;
  }catch(err){
    btn.disabled=false;
    const e=document.getElementById('err');
    e.textContent='sem conexão, tente novamente';
    e.style.display='block';
  }
}
</script>
</body>
</html>`;
}
