/**
 * B1 — regra pura: o slot escolhido continua válido para o serviço atual?
 *
 * Determinística (now injetável). Espelhada inline no HTML de
 * src/routes/public-booking.ts — manter as duas em paridade (SPEC RF-05).
 */

export type WorkingHour = {
	weekday: number;
	start_time: string;
	end_time: string;
};

export type BusyInterval = { start: string | Date; end: string | Date };

export type SlotValidityInput = {
	picked: Date;
	day: Date;
	durationMin: number;
	workingHours: WorkingHour[];
	busy: BusyInterval[];
	now: Date;
};

export function slotStillValid(input: SlotValidityInput): boolean {
	const { picked, day, durationMin, workingHours, busy, now } = input;

	// início estritamente futuro
	if (picked.getTime() <= now.getTime()) return false;

	// dia precisa ter working_hours
	const h = workingHours.find((x) => x.weekday === day.getDay());
	if (!h) return false;

	const parts = h.start_time.split(":").map(Number);
	const endParts = h.end_time.split(":").map(Number);
	const sh = parts[0] ?? 0;
	const sm = parts[1] ?? 0;
	const eh = endParts[0] ?? 0;
	const em = endParts[1] ?? 0;
	const opening = new Date(day);
	opening.setHours(sh, sm, 0, 0);
	const closing = new Date(day);
	closing.setHours(eh, em, 0, 0);

	// início >= abertura e início + duração <= fechamento
	if (picked.getTime() < opening.getTime()) return false;
	const end = picked.getTime() + durationMin * 60_000;
	if (end > closing.getTime()) return false;

	// [início, fim) não sobrepõe ocupação — encostar não conflita
	return !busy.some((b) => {
		const bs = new Date(b.start).getTime();
		const be = new Date(b.end).getTime();
		return picked.getTime() < be && end > bs;
	});
}
