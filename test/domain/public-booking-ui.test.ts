import { describe, expect, it } from "vitest";
import { slotStillValid } from "../../src/domain/public-booking-ui.js";

// helpers: dia Fix 2026-10-21 (qua), slots de 15min entre 09:00-18:00
const DAY = new Date(2026, 9, 21);
const at = (h: number, m = 0) => {
	const d = new Date(DAY);
	d.setHours(h, m, 0, 0);
	return d;
};
const WORKING = [
	{ weekday: DAY.getDay(), start_time: "09:00", end_time: "18:00" },
];

// ocupado 14:00-15:00
const BUSY = [{ start: at(14).toISOString(), end: at(15).toISOString() }];

describe("slotStillValid (B1 — trocar serviço não pode perder horário válido)", () => {
	it("mantém o horário quando ele continua válido para o novo serviço", () => {
		const picked = at(10);
		expect(
			slotStillValid({
				picked,
				day: DAY,
				durationMin: 60, // novo serviço mais longo
				workingHours: WORKING,
				busy: BUSY,
				now: at(8),
			}),
		).toBe(true);
	});

	it("limpa o horário quando o novo serviço colide com agendamento existente", () => {
		expect(
			slotStillValid({
				picked: at(14, 30),
				day: DAY,
				durationMin: 30,
				workingHours: WORKING,
				busy: BUSY,
				now: at(8),
			}),
		).toBe(false);
	});

	it("limpa o horário quando o serviço não cabe antes do fechamento", () => {
		// 17:30 + 60min estoura 18:00
		expect(
			slotStillValid({
				picked: at(17, 30),
				day: DAY,
				durationMin: 60,
				workingHours: WORKING,
				busy: [],
				now: at(8),
			}),
		).toBe(false);
	});

	it("limpa o horário quando o dia é fechado (sem working_hours)", () => {
		expect(
			slotStillValid({
				picked: at(10),
				day: DAY,
				durationMin: 30,
				workingHours: [], // domingo/fechado
				busy: [],
				now: at(8),
			}),
		).toBe(false);
	});

	it("limpa o horário no passado", () => {
		expect(
			slotStillValid({
				picked: at(8, 30),
				day: DAY,
				durationMin: 30,
				workingHours: WORKING,
				busy: [],
				now: at(9),
			}),
		).toBe(false);
	});
});
