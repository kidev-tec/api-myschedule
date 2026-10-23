/**
 * B1 — validade do slot escolhido ao trocar de serviço (link público).
 *
 * Regra pura e determinística (now injetável). Vetores da SPEC:
 * - slot que cabe na duração nova e está livre → true (RF-01)
 * - slot cruza ocupação com a duração nova → false (RF-02)
 * - slot + duração nova estoura o fechamento → false (RF-02)
 * - dia sem working_hours (fechado) → false
 * - slot no passado → false
 * - encostar não conflita: fim 10:00 com ocupação começando 10:00 → true
 */
import { describe, expect, it } from "vitest";

import { slotStillValid } from "../../src/domain/public-booking-ui.js";

type Hour = { weekday: number; start_time: string; end_time: string };
type Busy = { start: string; end: string };

const NOW = new Date("2026-10-23T08:30:00");

// 2026-10-23 é sexta (weekday 5); NOW uma hora antes do slot base
const baseInput = {
	picked: new Date("2026-10-23T09:00:00"),
	day: new Date("2026-10-23T00:00:00"),
	durationMin: 45,
	workingHours: [
		{ weekday: 5, start_time: "08:00", end_time: "18:00" },
	] as Hour[],
	busy: [
		{ start: "2026-10-23T10:00:00", end: "2026-10-23T10:30:00" },
	] as Busy[],
	now: NOW,
};

describe("slotStillValid (B1 — trocar serviço não pode perder horário válido)", () => {
	it("true quando cabe na duração nova e não cruza ocupação", () => {
		expect(slotStillValid(baseInput)).toBe(true);
	});

	it("false quando cruza ocupação com a duração nova", () => {
		// 09:30 + 60min = 10:30, atravessa a ocupação 10:00–10:30
		expect(
			slotStillValid({
				...baseInput,
				picked: new Date("2026-10-23T09:30:00"),
				durationMin: 60,
			}),
		).toBe(false);
	});

	it("false quando encostar de leve? não — encostar é válido (semiaberto)", () => {
		// 09:15 + 45min termina exatamente 10:00 onde começa a ocupação
		expect(
			slotStillValid({
				...baseInput,
				picked: new Date("2026-10-23T09:15:00"),
			}),
		).toBe(true);
	});

	it("false quando estoura o fechamento do dia", () => {
		// 17:30 + 60min = 18:30 > 18:00
		expect(
			slotStillValid({
				...baseInput,
				picked: new Date("2026-10-23T17:30:00"),
			}),
		).toBe(false);
	});

	it("false quando o dia é fechado (sem working_hours)", () => {
		expect(slotStillValid({ ...baseInput, workingHours: [] })).toBe(false);
	});

	it("false quando o slot está no passado", () => {
		expect(
			slotStillValid({
				...baseInput,
				picked: new Date("2026-10-23T08:30:00"),
			}),
		).toBe(false);
	});
});
