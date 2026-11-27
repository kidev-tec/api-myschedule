import { describe, expect, it } from "vitest";
import {
	daysLeft,
	eachDay,
	monthRange,
	parseLocalDate,
	spanDays,
	toKey,
} from "../../src/domain/report-period.js";

describe("RF-F07 — períodos em datas locais", () => {
	it("parseLocalDate aceita só datas reais AAAA-MM-DD", () => {
		expect(toKey(parseLocalDate("2026-02-28") as Date)).toBe("2026-02-28");
		for (const v of ["2026-02-30", "2026-2-1", "x", 20260101, undefined]) {
			expect(parseLocalDate(v)).toBeNull();
		}
	});

	it("eachDay e spanDays (inclusivos, atravessa mês)", () => {
		const a = parseLocalDate("2026-10-30") as Date;
		const b = parseLocalDate("2026-11-02") as Date;
		expect(eachDay(a, b)).toEqual([
			"2026-10-30",
			"2026-10-31",
			"2026-11-01",
			"2026-11-02",
		]);
		expect(spanDays(a, b)).toBe(4);
		expect(spanDays(a, a)).toBe(1);
	});

	it("monthRange: fevereiro bissexto e inválidos", () => {
		const [f, l] = monthRange("2028-02") as [Date, Date];
		expect([toKey(f), toKey(l)]).toEqual(["2028-02-01", "2028-02-29"]);
		expect(monthRange("2026-00")).toBeNull();
		expect(monthRange("2026-13")).toBeNull();
	});

	it("daysLeft conta hoje; passado 0; futuro o mês inteiro", () => {
		const nov = monthRange("2026-11") as [Date, Date];
		expect(daysLeft(nov, "2026-11-27")).toBe(4);
		expect(daysLeft(nov, "2026-11-30")).toBe(1);
		expect(daysLeft(nov, "2026-12-01")).toBe(0);
		expect(daysLeft(nov, "2026-10-15")).toBe(30);
	});
});
