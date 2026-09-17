/**
 * RF-B02 — Token HMAC de confirmação do cliente.
 * Sem login: o link do WhatsApp carrega token = HMAC-SHA256(appointmentId + startsAt).
 * Chave: FIREBASE_PROJECT_ID não é segredo bom o suficiente; usamos o
 * DATABASE_URL (presente só no servidor) como pepper + string fixa de domínio.
 * Não expira (o próprio fluxo rejeita horário no passado na UI).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const DOMAIN = "agenva-confirm-v1";

/**
 * Gera o token de confirmação de um agendamento.
 * @param appointmentId id do agendamento
 * @param startsAt início do agendamento (parte do payload assinado)
 * @param pepper segredo do servidor (default: DATABASE_URL do processo)
 */
export function confirmationToken(
	appointmentId: string,
	startsAt: Date,
	pepper: string = process.env.DATABASE_URL ?? "agenva-dev-pepper",
): string {
	const payload = `${DOMAIN}:${appointmentId}:${startsAt.toISOString()}`;
	return createHmac("sha256", pepper).update(payload).digest("hex");
}

/** Validação em constant-time. */
export function verifyConfirmationToken(
	appointmentId: string,
	startsAt: Date,
	token: string,
	pepper?: string,
): boolean {
	const expected = confirmationToken(appointmentId, startsAt, pepper);
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(token, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
