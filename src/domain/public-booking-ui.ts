/**
 * Lógica pura do link público de agendamento (B1 — SPEC
 * SPEC-B1-preservar-horario-troca-servico.md).
 *
 * Decide se um horário já escolhido continua válido quando o cliente troca
 * de serviço: mesmo dia/horário de funcionamento, dentro da janela, livre
 * considerando a duração do NOVO serviço e no futuro.
 *
 * Paridade: o HTML da página (/p/:slug) embute uma cópia JS desta função
 * (o browser não importa módulos). O teste de paridade em
 * test/routes/public-booking.test.ts extrai a cópia inline do HTML servido e
 * verifica comportamento IDÊNTICO ao desta função — mudar aqui sem mudar lá
 * quebra o teste.
 */

export interface WorkingHourRow {
	weekday: number;
	start_time: string; // "HH:MM"
	end_time: string; // "HH:MM"
}

export interface BusyInterval {
	start: string; // ISO
	end: string; // ISO
}

export interface SlotValidityInput {
	/** Slot escolhido (data+hora local). */
	picked: Date;
	/** Dia selecionado na grade. */
	day: Date;
	/** Duração do serviço AGORA selecionado, em minutos. */
	durationMin: number;
	workingHours: WorkingHourRow[];
	busy: BusyInterval[];
	/** Agora (injetável p/ teste). */
	now: Date;
}

export function slotStillValid(input: SlotValidityInput): boolean {
	const { picked, day, durationMin, workingHours, busy, now } = input;
	if (picked.getTime() <= now.getTime()) return false;

	const wd = day.getDay();
	const h = workingHours.find((x) => x.weekday === wd);
	if (!h) return false;

	const [sh = 0, sm = 0] = h.start_time.split(":").map(Number);
	const [eh = 0] = h.end_time.split(":").map(Number);
	const openMin = sh * 60 + sm;
	const closeMin = eh * 60;
	const startMin = picked.getHours() * 60 + picked.getMinutes();
	const endMin = startMin + durationMin;
	if (startMin < openMin || endMin > closeMin) return false;

	const startMs = picked.getTime();
	const endMs = startMs + durationMin * 60000;
	return !busy.some(
		(b) =>
			startMs < new Date(b.end).getTime() &&
			endMs > new Date(b.start).getTime(),
	);
}
