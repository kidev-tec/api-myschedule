export const MIN_DURATION_MIN = 15;
export const MAX_DURATION_MIN = 480;

export function isValidDurationMin(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= MIN_DURATION_MIN &&
		value <= MAX_DURATION_MIN &&
		value % MIN_DURATION_MIN === 0
	);
}

export type WorkingHour = {
	weekday: number;
	startTime: string;
	endTime: string;
};

export function resolveEffectiveInterval(
	start: Date,
	durationMin: number,
	legacyEnd?: Date,
): { end: Date } | null {
	if (!isValidDurationMin(durationMin)) return null;
	const end = new Date(start.getTime() + durationMin * 60_000);
	if (legacyEnd && legacyEnd.getTime() !== end.getTime()) return null;
	return { end };
}

function minutesOfTime(value: string): number | null {
	const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

// Intl formatter é caro de criar; cache por timezone (volume baixo, mas grátis).
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function localFormatter(timeZone: string): Intl.DateTimeFormat {
	let fmt = fmtCache.get(timeZone);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			weekday: "short",
			hour: "2-digit",
			minute: "2-digit",
		});
		fmtCache.set(timeZone, fmt);
	}
	return fmt;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Converte um instante UTC pra (dia-da-semana, minuto do dia) no fuso do business. */
function localMinutes(date: Date, timeZone: string) {
	const parts: Record<string, string> = {};
	for (const p of localFormatter(timeZone).formatToParts(date)) {
		parts[p.type] = p.value;
	}
	return {
		weekday: WEEKDAYS.indexOf(parts.weekday ?? "??"),
		minutes: Number(parts.hour) * 60 + Number(parts.minute),
		dayKey: `${parts.year}-${parts.month}-${parts.day}`,
	};
}

/**
 * Intervalo [start,end) precisa caber INTEGRALMENTE numa janela de
 * working_hours do dia (horário local do business). Encostar no fechamento
 * é válido. Cruzar meia-noite local não é (baseline: 1 dia = 1 janela).
 */
export function isWithinWorkingHours(
	start: Date,
	end: Date,
	hours: readonly WorkingHour[],
	timeZone: string,
): boolean {
	if (start >= end) return false;
	const s = localMinutes(start, timeZone);
	const e = localMinutes(end, timeZone);
	if (s.weekday < 0 || s.dayKey !== e.dayKey) return false;
	return hours.some((hour) => {
		const opening = minutesOfTime(hour.startTime);
		const closing = minutesOfTime(hour.endTime);
		return (
			hour.weekday === s.weekday &&
			opening !== null &&
			closing !== null &&
			opening <= s.minutes &&
			e.minutes <= closing
		);
	});
}
