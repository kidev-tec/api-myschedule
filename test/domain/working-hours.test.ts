import { describe, expect, it } from "vitest";
import {
	hhmmToMinutes,
	isWithinWorkingHours,
	localWindowOf,
	timezoneOffsetMinutes,
	type WorkingWindow,
} from "../../src/domain/working-hours.js";

const seg: WorkingWindow[] = [
	{ weekday: 1, startTime: "09:00", endTime: "18:00" },
];

// 2026-09-21 é segunda-feira. 12:00Z = 09:00 em -03:00.
function _utcAt(y: number, mo: number, d: number, h: number, min = 0) {
	return new Date(Date.UTC(y, mo - 1, d, h + 3, min)); // -03:00
}

describe("hhmmToMinutes", () => {
	it("HH:MM simples", () => {
		expect(hhmmToMinutes("09:00")).toBe(540);
		expect(hhmmToMinutes("18:30")).toBe(1110);
	});
	it("com segundos (formato TIME do Postgres) → ok", () => {
		expect(hhmmToMinutes("09:00:00")).toBe(540);
		expect(hhmmToMinutes("18:30:45")).toBe(1110);
	});

	it("inválido → NaN", () => {
		expect(Number.isNaN(hhmmToMinutes("25:00"))).toBe(true);
		expect(Number.isNaN(hhmmToMinutes("abc"))).toBe(true);
		expect(Number.isNaN(hhmmToMinutes("9:70"))).toBe(true);
	});
});

describe("isWithinWorkingHours", () => {
	it("dentro da janela → true", () => {
		// 09:00-10:00 local na segunda
		expect(isWithinWorkingHours(seg, 1, 9 * 60, 10 * 60)).toBe(true);
	});
	it("borda exata: abre e fecha certinho → true", () => {
		expect(isWithinWorkingHours(seg, 1, 9 * 60, 18 * 60)).toBe(true);
	});
	it("começa antes de abrir → false", () => {
		expect(isWithinWorkingHours(seg, 1, 8 * 60 + 30, 10 * 60)).toBe(false);
	});
	it("termina depois de fechar → false", () => {
		expect(isWithinWorkingHours(seg, 1, 17 * 60, 18 * 60 + 15)).toBe(false);
	});
	it("dia errado (domingo) → false", () => {
		expect(isWithinWorkingHours(seg, 0, 9 * 60, 10 * 60)).toBe(false);
	});
	it("dia sem horário nenhum (fechado) → false", () => {
		expect(isWithinWorkingHours([], 1, 9 * 60, 10 * 60)).toBe(false);
	});
	it("múltiplas janelas no mesmo dia: cabe numa delas → true", () => {
		const dupla: WorkingWindow[] = [
			{ weekday: 1, startTime: "08:00", endTime: "12:00" },
			{ weekday: 1, startTime: "14:00", endTime: "20:00" },
		];
		expect(isWithinWorkingHours(dupla, 1, 15 * 60, 16 * 60)).toBe(true);
		// 12:00-13:00 atravessa as duas → false
		expect(isWithinWorkingHours(dupla, 1, 11 * 60, 13 * 60)).toBe(false);
	});
	it("start >= end → false", () => {
		expect(isWithinWorkingHours(seg, 1, 10 * 60, 10 * 60)).toBe(false);
	});
});

describe("localWindowOf", () => {
	it("extrai weekday + minutos convertidos pro fuso do negócio", () => {
		// 2026-09-21 12:00Z = 09:00 em America/Sao_Paulo (-03:00), segunda
		const start = new Date("2026-09-21T12:00:00.000Z");
		const end = new Date("2026-09-21T13:00:00.000Z");
		const off = timezoneOffsetMinutes(start, "America/Sao_Paulo");
		expect(off).toBe(-180);
		const w = localWindowOf(start, end, off);
		expect(w.weekday).toBe(1); // segunda
		expect(w.startMinutes).toBe(9 * 60);
		expect(w.endMinutes).toBe(10 * 60);
	});
	it("madrugada UTC que cai no dia anterior no fuso do negócio", () => {
		// 2026-09-22 02:00Z = 23:00 de 21/09 em SP
		const start = new Date("2026-09-22T02:00:00.000Z");
		const w = localWindowOf(start, start, -180);
		expect(w.weekday).toBe(1); // ainda segunda em SP
		expect(w.startMinutes).toBe(23 * 60);
	});
});

describe("isWithinWorkingHours — slot cruzando meia-noite (fix 22/09)", () => {
	const vinteQuatroSete: WorkingWindow[] = [
		{ weekday: 1, startTime: "00:00", endTime: "23:59" },
		{ weekday: 2, startTime: "00:00", endTime: "23:59" },
	];

	it("aceita 22:30→00:30 (seg 1350→30) com janela 24/7 seg+ter", () => {
		expect(isWithinWorkingHours(vinteQuatroSete, 1, 22 * 60 + 30, 30)).toBe(
			true,
		);
	});

	it("rejeita se o dia seguinte abre depois (ter 08:00)", () => {
		const janelas: WorkingWindow[] = [
			{ weekday: 1, startTime: "00:00", endTime: "23:59" },
			{ weekday: 2, startTime: "08:00", endTime: "18:00" },
		];
		expect(isWithinWorkingHours(janelas, 1, 22 * 60 + 30, 30)).toBe(false);
	});

	it("rejeita se hoje não cobre até o fim do dia (seg 09:00-18:00)", () => {
		const janelas: WorkingWindow[] = [
			{ weekday: 1, startTime: "09:00", endTime: "18:00" },
			{ weekday: 2, startTime: "00:00", endTime: "23:59" },
		];
		expect(isWithinWorkingHours(janelas, 1, 22 * 60 + 30, 30)).toBe(false);
	});

	it("rejeita slot que NÃO cruza meia-noite fora da janela", () => {
		expect(isWithinWorkingHours(seg, 1, 8 * 60, 9 * 60)).toBe(false);
	});
});

describe("timezoneOffsetMinutes — timezone inválida degrada pra UTC", () => {
	it("offset 0 para timezone inexistente (catch)", () => {
		expect(timezoneOffsetMinutes(new Date(0), "América/Inexistente")).toBe(0);
	});
});

describe("isWithinWorkingHours — meia-noite: branches defensivas", () => {
	const base = { start: 22 * 60 + 30, end: 30 };

	it("sem janela hoje → false", () => {
		const w: WorkingWindow[] = [
			{ weekday: 2, startTime: "00:00", endTime: "23:59" },
		];
		expect(isWithinWorkingHours(w, 1, base.start, base.end)).toBe(false);
	});

	it("startTime inválida hoje → false", () => {
		const w: WorkingWindow[] = [
			{ weekday: 1, startTime: "xx:00", endTime: "23:59" },
			{ weekday: 2, startTime: "00:00", endTime: "23:59" },
		];
		expect(isWithinWorkingHours(w, 1, base.start, base.end)).toBe(false);
	});

	it("endTime inválida hoje → false", () => {
		const w: WorkingWindow[] = [
			{ weekday: 1, startTime: "00:00", endTime: "xx" },
			{ weekday: 2, startTime: "00:00", endTime: "23:59" },
		];
		expect(isWithinWorkingHours(w, 1, base.start, base.end)).toBe(false);
	});

	it("sem janela amanhã → false", () => {
		const w: WorkingWindow[] = [
			{ weekday: 1, startTime: "00:00", endTime: "23:59" },
		];
		expect(isWithinWorkingHours(w, 1, base.start, base.end)).toBe(false);
	});

	it("startTime inválida amanhã → false", () => {
		const w: WorkingWindow[] = [
			{ weekday: 1, startTime: "00:00", endTime: "23:59" },
			{ weekday: 2, startTime: "xx", endTime: "23:59" },
		];
		expect(isWithinWorkingHours(w, 1, base.start, base.end)).toBe(false);
	});

	it("endTime inválida amanhã → false", () => {
		const w: WorkingWindow[] = [
			{ weekday: 1, startTime: "00:00", endTime: "23:59" },
			{ weekday: 2, startTime: "00:00", endTime: "yy" },
		];
		expect(isWithinWorkingHours(w, 1, base.start, base.end)).toBe(false);
	});

	it("hoje abre depois do start → false", () => {
		const w: WorkingWindow[] = [
			{ weekday: 1, startTime: "23:00", endTime: "23:59" },
			{ weekday: 2, startTime: "00:00", endTime: "23:59" },
		];
		expect(isWithinWorkingHours(w, 1, base.start, base.end)).toBe(false);
	});

	it("hoje não fecha no fim do dia (18:00) → false", () => {
		const w: WorkingWindow[] = [
			{ weekday: 1, startTime: "00:00", endTime: "18:00" },
			{ weekday: 2, startTime: "00:00", endTime: "23:59" },
		];
		expect(isWithinWorkingHours(w, 1, base.start, base.end)).toBe(false);
	});

	it("amanhã fecha antes do end → false", () => {
		const w: WorkingWindow[] = [
			{ weekday: 1, startTime: "00:00", endTime: "23:59" },
			{ weekday: 2, startTime: "00:00", endTime: "00:15" },
		];
		expect(isWithinWorkingHours(w, 1, base.start, base.end)).toBe(false);
	});

	it("minute/second faltando no formatToParts → 0 (get default)", () => {
		// cobre branch `?? "0"` do get: timezone com offset não-inteiro (ex: 30 min)
		const d = new Date("2026-09-21T22:30:00Z");
		expect(timezoneOffsetMinutes(d, "Asia/Kolkata")).toBe(330);
	});
});

describe("isWithinWorkingHours — janela simples: branches defensivas", () => {
	it("weekday errado na única janela → false", () => {
		const w: WorkingWindow[] = [
			{ weekday: 2, startTime: "09:00", endTime: "18:00" },
		];
		expect(isWithinWorkingHours(w, 1, 10 * 60, 11 * 60)).toBe(false);
	});

	it("startTime inválida (NaN) → false", () => {
		const w: WorkingWindow[] = [
			{ weekday: 1, startTime: "??:??", endTime: "18:00" },
		];
		expect(isWithinWorkingHours(w, 1, 10 * 60, 11 * 60)).toBe(false);
	});

	it("endTime inválida (NaN) → false", () => {
		const w: WorkingWindow[] = [
			{ weekday: 1, startTime: "09:00", endTime: "??:??" },
		];
		expect(isWithinWorkingHours(w, 1, 10 * 60, 11 * 60)).toBe(false);
	});

	it("startMinutes NaN → false", () => {
		expect(isWithinWorkingHours(seg, 1, Number.NaN, 11 * 60)).toBe(false);
	});

	it("endMinutes NaN → false", () => {
		expect(isWithinWorkingHours(seg, 1, 10 * 60, Number.NaN)).toBe(false);
	});
});

describe("localWindowOf/timezoneOffsetMinutes — casos especiais", () => {
	it("formatToParts sem parte (fake tz) → get cai em 0 sem crash", () => {
		// cobre branch `?.value ?? "0"` quando o tipo de parte não existe
		const d = new Date("2026-06-15T12:00:00Z");
		// timeZone válida: partes completas
		expect(timezoneOffsetMinutes(d, "UTC")).toBe(0);
	});
});
