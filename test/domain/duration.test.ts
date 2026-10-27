import { describe, expect, it } from "vitest";
import {
	isValidDurationMin,
	isWithinWorkingHours,
	resolveEffectiveInterval,
} from "../../src/domain/duration.js";

const at = (time: string) => new Date(`2026-11-02T${time}:00.000Z`); // segunda

describe("duração flexível", () => {
	it.each([15, 30, 480])("aceita %i min", (value) => {
		expect(isValidDurationMin(value)).toBe(true);
	});

	it.each([14, 481, 22.5, 22, "30", null])("rejeita %p", (value) => {
		expect(isValidDurationMin(value)).toBe(false);
	});

	it("calcula fim pelo override", () => {
		expect(resolveEffectiveInterval(at("09:00"), 30, undefined)?.end).toEqual(at("09:30"));
	});

	it("aceita intervalo encostado no fechamento", () => {
		// UTC 14:30-15:00 == 11:30-12:00 local SP, encostando no fechamento 12:00
		expect(isWithinWorkingHours(at("14:30"), at("15:00"), [{ weekday: 1, startTime: "09:00:00", endTime: "12:00:00" }], "America/Sao_Paulo")).toBe(true);
	});

	it("rejeita intervalo que ultrapassa fechamento", () => {
		// UTC 14:30-15:30 == 11:30-12:30 local SP, passa do fechamento 12:00
		expect(isWithinWorkingHours(at("14:30"), at("15:30"), [{ weekday: 1, startTime: "09:00:00", endTime: "12:00:00" }], "America/Sao_Paulo")).toBe(false);
	});

	it("converte fuso: 09:00 local SP = 12:00 UTC (janela abre 09:00 local)", () => {
		// UTC 12:00-12:30 == 09:00-09:30 em São Paulo (segunda-feira local)
		expect(isWithinWorkingHours(at("12:00"), at("12:30"), [{ weekday: 1, startTime: "09:00:00", endTime: "12:00:00" }], "America/Sao_Paulo")).toBe(true);
		// abertura 09:00 local → 08:59 UTC ainda não abriu
		expect(isWithinWorkingHours(at("11:59"), at("12:00"), [{ weekday: 1, startTime: "09:00:00", endTime: "12:00:00" }], "America/Sao_Paulo")).toBe(false);
	});
});
