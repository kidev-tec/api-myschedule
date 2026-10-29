/**
 * Dia do calendário no fuso do NEGÓCIO (não do servidor, que é UTC em
 * produção). Usado nas regras que dependem de "hoje" — ex.: só dá pra
 * concluir/marcar falta de agendamento de hoje ou de antes.
 */

/** Data `YYYY-MM-DD` de `d` no fuso `timeZone`. */
export function dayKey(d: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(d);
}

/** true se `startsAt` cai hoje ou num dia anterior, no fuso do negócio. */
export function startsOnOrBeforeToday(
	startsAt: Date,
	timeZone: string,
	now: Date = new Date(),
): boolean {
	return dayKey(startsAt, timeZone) <= dayKey(now, timeZone);
}
