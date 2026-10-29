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
		data?: Record<string, string>;
		android?: {
			priority: "high" | "normal";
			notification: { channelId: string; defaultSound: boolean };
		};
		apns?: { payload: { aps: { sound: string } } };
	}): Promise<string>;
};

/** Canal Android dos avisos (criado pelo app: "Agendamentos"). */
export const ANDROID_CHANNEL_ID = "agendamentos";

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
	data?: Record<string, string>,
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
					// dados pro app reagir (ex.: atualizar a agenda)
					...(data ? { data } : {}),
					// Som/vibração = padrão do celular: o próprio aparelho decide
					// (normal toca, vibrar vibra, silencioso fica quieto).
					android: {
						priority: "high",
						notification: {
							channelId: ANDROID_CHANNEL_ID,
							defaultSound: true,
						},
					},
					apns: { payload: { aps: { sound: "default" } } },
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
