/**
 * Push via Firebase Cloud Messaging (firebase-admin/messaging).
 * Import LAZY: o módulo só carrega o admin quando envia de verdade —
 * testes rodam sem credenciais.
 * sendToUser NUNCA lança: push é best-effort, falha só loga.
 */

import { eq } from "drizzle-orm";
import { type Db, getDb } from "../db/connection.js";
import { deviceTokens } from "../db/schema.js";

type Messaging = {
	send(message: {
		token: string;
		notification: { title: string; body: string };
	}): Promise<string>;
};

let messaging: Messaging | null = null;

async function getMessaging(): Promise<Messaging | null> {
	if (messaging !== null) {
		return messaging;
	}
	try {
		const { getMessaging: m } = await import("firebase-admin/messaging");
		messaging = m() as unknown as Messaging;
		return messaging;
	} catch (e) {
		console.error("[fcm] indisponível:", e);
		return null;
	}
}

/**
 * Envia push para todos os devices do user. Limpa tokens mortos
 * (registration-token-not-registered). Nunca lança.
 */
export async function sendToUser(
	databaseUrl: string,
	userId: string,
	title: string,
	body: string,
): Promise<void> {
	try {
		const m = await getMessaging();
		if (!m) return;
		const db: Db = getDb(databaseUrl);
		const tokens = await db
			.select()
			.from(deviceTokens)
			.where(eq(deviceTokens.userId, userId));
		if (tokens.length === 0) return;
		for (const t of tokens) {
			try {
				await m.send({
					token: t.fcmToken,
					notification: { title, body },
				});
			} catch (err) {
				const code =
					typeof err === "object" && err !== null && "code" in err
						? String((err as { code: unknown }).code)
						: "";
				if (
					code === "messaging/registration-token-not-registered" ||
					code === "messaging/invalid-registration-token"
				) {
					await db.delete(deviceTokens).where(eq(deviceTokens.id, t.id));
				} else {
					console.error("[fcm] erro no envio:", code);
				}
			}
		}
	} catch (e) {
		console.error("[fcm] sendToUser falhou (ignorado):", e);
	}
}
