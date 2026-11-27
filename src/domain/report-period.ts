/**
 * Períodos dos relatórios financeiros em DATAS LOCAIS do negócio
 * ("YYYY-MM-DD"). A conversão de timestamp → dia local é feita no SQL
 * (AT TIME ZONE); aqui só aritmética de calendário (puro, sem fuso).
 */

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" válido (rejeita 2026-02-30) → Date UTC 00:00; senão null. */
export function parseLocalDate(v: unknown): Date | null {
	if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
	const d = new Date(`${v}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) ? d : null;
}

export const toKey = (d: Date) => d.toISOString().slice(0, 10);

/** Dias do período, inclusivos (from ≤ to). */
export function eachDay(from: Date, to: Date): string[] {
	const out: string[] = [];
	for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
		out.push(toKey(new Date(t)));
	}
	return out;
}

/** Quantidade de dias do período, inclusiva. */
export const spanDays = (from: Date, to: Date) =>
	Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;

/** "YYYY-MM" válido → [1º dia, último dia]; senão null. */
export function monthRange(v: string): [Date, Date] | null {
	if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) return null;
	const [y, m] = v.split("-").map(Number) as [number, number];
	return [new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 0))];
}

/**
 * Dias que faltam no mês contando hoje ([today] = dia local "YYYY-MM-DD"):
 * mês passado → 0; mês futuro → todos; mês atual → até o fim, com hoje.
 */
export function daysLeft(range: [Date, Date], today: string): number {
	const t = parseLocalDate(today) as Date;
	const [first, last] = range;
	if (t > last) return 0;
	if (t < first) return spanDays(first, last);
	return spanDays(t, last);
}
