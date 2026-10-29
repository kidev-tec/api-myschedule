import { describe, expect, it } from "vitest";
import {
	dayKey,
	startsOnOrBeforeToday,
} from "../../src/domain/schedule-day.js";

describe("dayKey", () => {
	it("data no fuso informado (não no do servidor)", () => {
		// 02:00 UTC do dia 29 = 23:00 do dia 28 em Brasília
		const d = new Date("2026-10-29T02:00:00Z");
		expect(dayKey(d, "America/Sao_Paulo")).toBe("2026-10-28");
		expect(dayKey(d, "UTC")).toBe("2026-10-29");
	});
});

describe("startsOnOrBeforeToday", () => {
	const now = new Date("2026-10-28T20:00:00Z"); // 17:00 em Brasília

	it("passado → true", () => {
		expect(
			startsOnOrBeforeToday(
				new Date("2026-10-27T12:00:00Z"),
				"America/Sao_Paulo",
				now,
			),
		).toBe(true);
	});

	it("hoje mais tarde → true", () => {
		// 23:00 do dia 28 em Brasília (02:00 UTC do dia 29)
		expect(
			startsOnOrBeforeToday(
				new Date("2026-10-29T02:00:00Z"),
				"America/Sao_Paulo",
				now,
			),
		).toBe(true);
	});

	it("dia seguinte → false", () => {
		expect(
			startsOnOrBeforeToday(
				new Date("2026-10-29T12:00:00Z"),
				"America/Sao_Paulo",
				now,
			),
		).toBe(false);
	});

	it("usa o fuso do negócio: mesmo instante é amanhã em UTC", () => {
		const s = new Date("2026-10-29T02:00:00Z");
		expect(startsOnOrBeforeToday(s, "UTC", now)).toBe(false);
	});

	it("now padrão = agora", () => {
		expect(startsOnOrBeforeToday(new Date(0), "America/Sao_Paulo")).toBe(true);
	});
});
