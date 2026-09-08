import { describe, expect, it } from "vitest";
// Runtime: sufixo .js é remapeado para .ts pelo plugin js-to-ts (vitest.config.ts)
import { overlaps } from "../../src/domain/booking.js";

describe("overlaps — conflito de horário (regra central do negócio)", () => {
  const day = "2026-09-10";
  const at = (h: number, m = 0) => new Date(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);

  it("rejeita agendamento que sobrepõe parcialmente no início", () => {
    // existente 10:00-11:00, novo 10:30-11:30
    expect(overlaps(at(10), at(11), at(10, 30), at(11, 30))).toBe(true);
  });

  it("rejeita agendamento que contém um existente", () => {
    // existente 10:30-11:00, novo 10:00-12:00
    expect(overlaps(at(10, 30), at(11), at(10), at(12))).toBe(true);
  });

  it("rejeita agendamento contido num existente", () => {
    expect(overlaps(at(10), at(12), at(10, 30), at(11))).toBe(true);
  });

  it("permite agendamento encostado no fim (10:00-11:00 e 11:00-12:00)", () => {
    expect(overlaps(at(10), at(11), at(11), at(12))).toBe(false);
  });

  it("permite agendamento encostado no início (10:00-11:00 e 09:00-10:00)", () => {
    expect(overlaps(at(10), at(11), at(9), at(10))).toBe(false);
  });

  it("permite horários totalmente distintos", () => {
    expect(overlaps(at(10), at(11), at(14), at(15))).toBe(false);
  });

  it("rejeita intervalo invertido (defesa de contrato)", () => {
    expect(() => overlaps(at(11), at(10), at(10), at(11))).toThrow(/invariant|start >= end/i);
    expect(() => overlaps(at(10), at(11), at(12), at(11))).toThrow(/invariant|start >= end/i);
  });

  it("rejeita zero-duration (defesa de contrato)", () => {
    expect(() => overlaps(at(10), at(10), at(10), at(11))).toThrow(/invariant|start >= end/i);
  });
});
