import { describe, expect, it } from "vitest";
import {
	isValidBufferMin,
	isValidDurationMin,
	isWithinWorkingHours,
	occupiedEnd,
	resolveEffectiveInterval,
} from "../../src/domain/duration.js";

const at = (time: string) => new Date(`2026-11-02T${time}:00.000Z`); // segunda

describe("duração flexível", () => {
	it.each([5, 15, 25, 30, 480])("aceita %i min", (value) => {
		expect(isValidDurationMin(value)).toBe(true);
	});

	it.each([0, 4, 481, 22.5, 22, "30", null])("rejeita %p", (value) => {
		expect(isValidDurationMin(value)).toBe(false);
	});

	it.each([0, 5, 10, 30, 120])("folga: aceita %i min", (value) => {
		expect(isValidBufferMin(value)).toBe(true);
	});

	it.each([-5, 7, 125, 2.5, "10", null])("folga: rejeita %p", (value) => {
		expect(isValidBufferMin(value)).toBe(false);
	});

	it("occupiedEnd soma a folga ao fim", () => {
		expect(occupiedEnd(at("09:30"), 10)).toEqual(at("09:40"));
		expect(occupiedEnd(at("09:30"), 0)).toEqual(at("09:30"));
	});

	it("calcula fim pelo override", () => {
		expect(resolveEffectiveInterval(at("09:00"), 30, undefined)?.end).toEqual(
			at("09:30"),
		);
	});

	it("aceita intervalo encostado no fechamento", () => {
		// UTC 14:30-15:00 == 11:30-12:00 local SP, encostando no fechamento 12:00
		expect(
			isWithinWorkingHours(
				at("14:30"),
				at("15:00"),
				[{ weekday: 1, startTime: "09:00:00", endTime: "12:00:00" }],
				"America/Sao_Paulo",
			),
		).toBe(true);
	});

	it("rejeita intervalo que ultrapassa fechamento", () => {
		// UTC 14:30-15:30 == 11:30-12:30 local SP, passa do fechamento 12:00
		expect(
			isWithinWorkingHours(
				at("14:30"),
				at("15:30"),
				[{ weekday: 1, startTime: "09:00:00", endTime: "12:00:00" }],
				"America/Sao_Paulo",
			),
		).toBe(false);
	});

	it("converte fuso: 09:00 local SP = 12:00 UTC (janela abre 09:00 local)", () => {
		// UTC 12:00-12:30 == 09:00-09:30 em São Paulo (segunda-feira local)
		expect(
			isWithinWorkingHours(
				at("12:00"),
				at("12:30"),
				[{ weekday: 1, startTime: "09:00:00", endTime: "12:00:00" }],
				"America/Sao_Paulo",
			),
		).toBe(true);
		// abertura 09:00 local → 08:59 UTC ainda não abriu
		expect(
			isWithinWorkingHours(
				at("11:59"),
				at("12:00"),
				[{ weekday: 1, startTime: "09:00:00", endTime: "12:00:00" }],
				"America/Sao_Paulo",
			),
		).toBe(false);
	});

	it("resolveEffectiveInterval: duração inválida ou endsAt coerente", () => {
		expect(resolveEffectiveInterval(at("09:00"), 7)).toBeNull();
		expect(resolveEffectiveInterval(at("09:00"), 30, at("09:30"))?.end).toEqual(
			at("09:30"),
		);
		expect(resolveEffectiveInterval(at("09:00"), 30, at("09:45"))).toBeNull();
	});

	it("isWithinWorkingHours: casos degenerados", () => {
		const wh = [{ weekday: 1, startTime: "09:00:00", endTime: "18:00:00" }];
		const tz = "America/Sao_Paulo";
		// início >= fim
		expect(isWithinWorkingHours(at("13:00"), at("13:00"), wh, tz)).toBe(false);
		// cruza a meia-noite local (segunda 23:30 → terça 00:30 em SP)
		expect(
			isWithinWorkingHours(
				new Date("2026-11-03T02:30:00.000Z"),
				new Date("2026-11-03T03:30:00.000Z"),
				[{ weekday: 1, startTime: "00:00", endTime: "23:59" }],
				tz,
			),
		).toBe(false);
		// horário malformado / fora de faixa na janela
		expect(
			isWithinWorkingHours(
				at("13:00"),
				at("13:30"),
				[{ weekday: 1, startTime: "9:00", endTime: "18:00" }],
				tz,
			),
		).toBe(false);
		expect(
			isWithinWorkingHours(
				at("13:00"),
				at("13:30"),
				[{ weekday: 1, startTime: "09:00", endTime: "24:00" }],
				tz,
			),
		).toBe(false);
	});
});
