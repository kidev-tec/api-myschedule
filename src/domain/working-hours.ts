/**
 * Regra: agendamento só dentro do horário de funcionamento (item 4 do
 * feedback 22/09 — "não será permitido agendamentos fora do horário").
 *
 * Pure: recebe os horários do dia (já filtrados por weekday) e o intervalo
 * pedido. Horários são "HH:MM" locais do negócio (timezone da conta) —
 * o chamador converte o Date UTC pra hora local antes.
 *
 * Sem horário cadastrado pro dia = dia fechado → sempre fora.
 * Bloqueios (source='block') não passam por aqui: ocupam slot, não pedem.
 */

export interface WorkingWindow {
	weekday: number; // 0=dom .. 6=sáb (getDay() do JS)
	startTime: string; // "HH:MM"
	endTime: string; // "HH:MM"
}

/** "HH:MM" ou "HH:MM:SS" (Postgres TIME devolve com segundos) → minutos
 *  desde 00:00. Inválido → NaN (rejeita). */
export function hhmmToMinutes(hhmm: string): number {
	const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(hhmm.trim());
	if (!m) return Number.NaN;
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (h > 23 || min > 59) return Number.NaN;
	return h * 60 + min;
}

/**
 * O intervalo [startMinutes, endMinutes) cabe inteiro dentro de ALGUMA
 * janela do dia? (múltiplas janelas por dia são suportadas — ex: 12h-13h
 * almoço partido em duas janelas).
 */
export function isWithinWorkingHours(
	windows: WorkingWindow[],
	weekday: number,
	startMinutes: number,
	endMinutes: number,
): boolean {
	if (Number.isNaN(startMinutes) || Number.isNaN(endMinutes)) return false;

	// Se NÃO cruza meia-noite: verificação simples numa janela do dia
	if (endMinutes > startMinutes) {
		return windows.some((w) => {
			if (w.weekday !== weekday) return false;
			const open = hhmmToMinutes(w.startTime);
			const close = hhmmToMinutes(w.endTime);
			if (Number.isNaN(open) || Number.isNaN(close)) return false;
			return startMinutes >= open && endMinutes <= close;
		});
	}

	// CRUZA MEIA-NOITE (endMinutes <= startMinutes): precisa de expediente hoje (start até 23:59) E amanhã (00:00 até end)
	const today = windows.find((w) => w.weekday === weekday);
	if (!today) return false;
	const openToday = hhmmToMinutes(today.startTime);
	const closeToday = hhmmToMinutes(today.endTime);
	if (Number.isNaN(openToday) || Number.isNaN(closeToday)) return false;
	const todayOk = startMinutes >= openToday && 1439 <= closeToday; // 1439 = 23:59
	if (!todayOk) return false;

	const tomorrow = windows.find((w) => w.weekday === (weekday + 1) % 7);
	if (!tomorrow) return false;
	const openTom = hhmmToMinutes(tomorrow.startTime);
	const closeTom = hhmmToMinutes(tomorrow.endTime);
	if (Number.isNaN(openTom) || Number.isNaN(closeTom)) return false;

	return 0 >= openTom && endMinutes <= closeTom; // 0 = 00:00
}

/** Extrai (weekday, minutos de início/fim) já convertidos pro fuso do negócio.
 *  offsetMinutes = fuso do negócio em minutos (ex: -03:00 → -180). O chamador
 *  lê do businesses.timezone (coluna existe) — o domínio fica puro e testável. */
export function localWindowOf(
	start: Date,
	end: Date,
	offsetMinutes: number,
): { weekday: number; startMinutes: number; endMinutes: number } {
	const shift = (d: Date) => new Date(d.getTime() + offsetMinutes * 60_000);
	const s = shift(start);
	const e = shift(end);
	return {
		weekday: s.getUTCDay(),
		startMinutes: s.getUTCHours() * 60 + s.getUTCMinutes(),
		endMinutes: e.getUTCHours() * 60 + e.getUTCMinutes(),
	};
}

/** "America/Sao_Paulo" (ou outro IANA) → offset em minutos NAQUELE instante. */
export function timezoneOffsetMinutes(date: Date, timeZone: string): number {
	try {
		const dtf = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hour12: false,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		const parts = dtf.formatToParts(date);
		/* v8 ignore next -- formatToParts de IANA válida sempre inclui year/month/day/hour/minute/second */
		const get = (t: string) =>
			Number(parts.find((p) => p.type === t)?.value ?? "0");
		const asUTC = Date.UTC(
			get("year"),
			get("month") - 1,
			get("day"),
			get("hour") % 24,
			get("minute"),
			get("second"),
		);
		return Math.round((asUTC - date.getTime()) / 60_000);
	} catch {
		return 0; // timezone inválida → trata como UTC (degrada p/ validação frouxa? NÃO: caller decide)
	}
}
