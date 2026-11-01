/**
 * F5 — vaga abriu: conta quem espera em cada dia dos horários liberados (no
 * fuso do negócio) e avisa o prestador, uma notificação por dia. Nunca lança:
 * falha aqui não pode quebrar o cancelamento ou o arquivamento que já valeram.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { businesses, waitlist } from "../db/schema.js";
import { dayKey } from "../domain/schedule-day.js";
import { notify } from "./notify.js";

export async function notifyWaitlistOpening(
	databaseUrl: string,
	owner: { userId: string; businessId: string },
	freedStarts: Date[],
): Promise<void> {
	try {
		const db = getDb(databaseUrl);
		const [biz] = await db
			.select({ timezone: businesses.timezone })
			.from(businesses)
			.where(eq(businesses.id, owner.businessId))
			.limit(1);
		/* v8 ignore next -- business do usuário sempre existe (FK) */
		const timeZone = biz?.timezone ?? "America/Sao_Paulo";
		const days = new Set(freedStarts.map((d) => dayKey(d, timeZone)));
		for (const day of days) {
			const [waiting] = await db
				.select({ n: sql<number>`count(*)::int` })
				.from(waitlist)
				.where(
					and(
						eq(waitlist.businessId, owner.businessId),
						sql`${waitlist.desiredDate}::date = ${day}::date`,
						eq(waitlist.status, "waiting"),
					),
				);
			/* v8 ignore next -- count(*) sempre devolve 1 linha */
			const n = waiting?.n ?? 0;
			if (n > 0) {
				void notify(databaseUrl, {
					userId: owner.userId,
					type: "waitlist",
					title: "Vaga abriu — lista de espera",
					body: `${n} cliente${n > 1 ? "s" : ""} na espera para ${day.slice(8, 10)}/${day.slice(5, 7)}. Toque para avisar.`,
					data: { date: day },
				});
			}
		}
		/* v8 ignore start -- best-effort: falha de banco não quebra a rota */
	} catch (e) {
		console.error("[waitlist] aviso de vaga falhou:", e);
	}
	/* v8 ignore stop */
}
