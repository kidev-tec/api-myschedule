/**
 * 0024 — notificação do prestador: GUARDA na central (sino + lista no app)
 * e manda o push (FCM). Todo aviso pro prestador passa por aqui, então o que
 * chega no celular também fica na lista, mesmo se for descartado da bandeja.
 * Nunca lança: falha de banco/push não pode quebrar a rota que avisou.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { notifications, users } from "../db/schema.js";
import { sendToUser } from "./fcm.js";

/** Tipos de notificação (o app escolhe ícone/ação por eles). */
export type NotificationType =
	| "new_booking" // cliente agendou pelo link
	| "client_confirmed" // cliente confirmou presença pelo link
	| "client_canceled" // cliente cancelou pelo link
	| "reminder" // lembrete de agendamento (24h antes)
	| "waitlist"; // vaga abriu num dia com lista de espera

export async function notify(
	databaseUrl: string,
	n: {
		userId: string;
		type: NotificationType;
		title: string;
		body: string;
		data?: Record<string, string>;
	},
): Promise<void> {
	let notificationId: string | undefined;
	try {
		const db = getDb(databaseUrl);
		const [u] = await db
			.select({ businessId: users.businessId })
			.from(users)
			.where(eq(users.id, n.userId))
			.limit(1);
		if (u) {
			const [row] = await db
				.insert(notifications)
				.values({
					businessId: u.businessId,
					userId: n.userId,
					type: n.type,
					title: n.title.slice(0, 200),
					body: n.body,
					data: n.data ?? null,
				})
				.returning({ id: notifications.id });
			notificationId = row?.id;
		}
	} catch (e) {
		console.error("[notify] não guardou (push segue):", e);
	}
	// type + id no push: o app atualiza o sino e abre a notificação certa
	await sendToUser(databaseUrl, n.userId, n.title, n.body, {
		...(n.data ?? {}),
		type: n.type,
		...(notificationId ? { notification_id: notificationId } : {}),
	});
}
