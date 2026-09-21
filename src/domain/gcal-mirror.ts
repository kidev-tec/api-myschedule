/**
 * Espelho de agendamentos no Google Calendar (RF-08).
 *
 * Ciclo do evento espelhado no Calendar do profissional:
 * - confirmado   → cria evento, salva gcal_event_id
 * - remarca (PATCH de horário em confirmed) → atualiza o evento
 * - cancelado/noshow → remove o evento
 * - GCal desconectado ou evento já removido → no-op silencioso
 *
 * O access_token é renovado a cada espelhada (refresh → use → descarte);
 * simples e à prova de expiração. Volume do MVP não justifica cache.
 *
 * Erros NUNCA derrubam o fluxo do agendamento: o caller usa fire-and-forget
 * com console.error — Calendar é espelho, não fonte de verdade.
 */

import { eq } from "drizzle-orm";
import { type Db, getDb } from "../db/connection.js";
import { appointments, businesses, clients, services } from "../db/schema.js";
import { decryptToken } from "./token-crypto.js";

const GCAL_TOKEN = "https://oauth2.googleapis.com/token";
const GCAL_EVENTS =
	"https://www.googleapis.com/calendar/v3/calendars/primary/events";

function env(name: string): string {
	return process.env[name] ?? "";
}

async function getAccessToken(refreshToken: string): Promise<string> {
	const res = await fetch(GCAL_TOKEN, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			refresh_token: refreshToken,
			client_id: env("GCAL_CLIENT_ID"),
			client_secret: env("GCAL_CLIENT_SECRET"),
			grant_type: "refresh_token",
		}),
	});
	if (!res.ok) throw new Error(`token refresh falhou: ${res.status}`);
	const json = (await res.json()) as { access_token?: string };
	/* v8 ignore next -- defensivo: Google sempre devolve access_token no 200 */
	if (!json.access_token) throw new Error("sem access_token na resposta");
	return json.access_token;
}

function eventBody(input: {
	startsAt: Date;
	endsAt: Date;
	clientName: string;
	clientPhone: string | null;
	serviceName: string;
}): string {
	const fmt = (d: Date) =>
		d.toISOString().replace(/[-:]/g, "").replace(".000", "");
	return JSON.stringify({
		summary: `${input.serviceName} — ${input.clientName}`,
		description: `Cliente: ${input.clientName}${input.clientPhone ? ` (${input.clientPhone})` : ""}\nVia Minha Agenda`,
		start: { dateTime: fmt(input.startsAt) },
		end: { dateTime: fmt(input.endsAt) },
		reminders: { useDefault: true },
	});
}

interface ApptMirrorRow {
	startsAt: Date;
	endsAt: Date;
	clientName: string;
	clientPhone: string | null;
	serviceName: string;
	refreshToken: string | null;
	gcalEventId: string | null;
}

async function loadMirrorRow(
	db: Db,
	appointmentId: string,
): Promise<ApptMirrorRow | null> {
	const appt = (
		await db
			.select({
				startsAt: appointments.startsAt,
				endsAt: appointments.endsAt,
				clientName: clients.name,
				clientPhone: clients.phoneE164,
				serviceName: services.name,
				refreshToken: businesses.gcalRefreshToken,
				gcalEventId: appointments.gcalEventId,
			})
			.from(appointments)
			.innerJoin(clients, eq(appointments.clientId, clients.id))
			.innerJoin(services, eq(appointments.serviceId, services.id))
			.innerJoin(businesses, eq(appointments.businessId, businesses.id))
			.where(eq(appointments.id, appointmentId))
			.limit(1)
	)[0];
	return appt ?? null;
}

/**
 * Espelha o estado atual do agendamento no Calendar:
 * cria se confirmado sem evento, atualiza se mudou horário,
 * remove se cancelado/noshow. No-op se GCal desconectado.
 */
export async function mirrorToCalendar(
	databaseUrl: string,
	appointmentId: string,
): Promise<void> {
	const db: Db = getDb(databaseUrl);
	const appt = await loadMirrorRow(db, appointmentId);
	if (!appt) return;

	// callback stale: appointment mudou de estado enquanto o mirror rodava —
	// recarregar status pra não criar evento de cancelado
	const status = (
		await db
			.select({ status: appointments.status })
			.from(appointments)
			.where(eq(appointments.id, appointmentId))
			.limit(1)
	)[0]?.status;
	/* v8 ignore next -- defensivo: agendamento apagado durante o espelho */
	if (!status) return;

	if (status !== "confirmed") {
		// cancelado/noshow/pending: só remove se já existia evento
		if (appt.gcalEventId && appt.refreshToken) {
			const token = await getAccessToken(decryptToken(appt.refreshToken));
			const del = await fetch(
				`${GCAL_EVENTS}/${encodeURIComponent(appt.gcalEventId)}`,
				{ method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
			);
			if (del.ok || del.status === 404 || del.status === 410) {
				await db
					.update(appointments)
					.set({ gcalEventId: null })
					.where(eq(appointments.id, appointmentId));
			}
			// 4xx/5xx diferente de gone: não limpa o id (pode remover depois)
		}
		return;
	}

	// status === confirmed
	if (!appt.refreshToken) return; // GCal não conectado: nada a fazer

	const token = await getAccessToken(decryptToken(appt.refreshToken));
	const body = eventBody(appt);

	if (appt.gcalEventId) {
		// já espelhado: atualiza (remarcação de horário)
		const res = await fetch(
			`${GCAL_EVENTS}/${encodeURIComponent(appt.gcalEventId)}`,
			{
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body,
			},
		);
		// 404/410 = evento apagado manualmente no Calendar → recria
		if (res.status === 404 || res.status === 410) {
			await db
				.update(appointments)
				.set({ gcalEventId: null })
				.where(eq(appointments.id, appointmentId));
			return mirrorToCalendar(databaseUrl, appointmentId);
		}
		if (!res.ok) throw new Error(`atualizar evento falhou: ${res.status}`);
		return;
	}

	// confirmado sem evento: cria
	const res = await fetch(`${GCAL_EVENTS}?sendUpdates=none`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body,
	});
	if (!res.ok) throw new Error(`criar evento falhou: ${res.status}`);
	const created = (await res.json()) as { id?: string };
	if (!created.id) {
		/* v8 ignore next -- defensivo: Google sempre devolve id no 201 */
		throw new Error("evento criado sem id");
	}
	// Revalida status: se cancelou durante o POST, não grava o id
	// (evita race com mirror de cancelamento).
	const still = (
		await db
			.select({ status: appointments.status })
			.from(appointments)
			.where(eq(appointments.id, appointmentId))
			.limit(1)
	)[0]?.status;
	if (still !== "confirmed") {
		try {
			await fetch(`${GCAL_EVENTS}/${encodeURIComponent(created.id)}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}` },
			});
		} catch {
			/* best-effort: evento órfão no Calendar */
		}
		return;
	}
	await db
		.update(appointments)
		.set({ gcalEventId: created.id })
		.where(eq(appointments.id, appointmentId));
}
