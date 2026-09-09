/**
 * Testes unitários do paywall (RF-14).
 *
 * canWrite é puro — testa a tabela de decisão completa:
 * - active → true
 * - trial com futuro → true / com passado → false / null → true
 * - canceled/past_due/qualquer outro → false
 *
 * loadBusinessGate e requireWritableFactory cobertos via integração:
 * - gate !me / !biz → null → middleware 404
 * - trial vencido → 402 em POST; GET continua livre
 */

import { describe, expect, it } from "vitest";
import { type BusinessGate, canWrite } from "../../src/middleware/paywall.js";

function gate(status: string, trialEndsAt: Date | null): BusinessGate {
	return { businessId: "b1", subscriptionStatus: status, trialEndsAt };
}

describe("paywall: canWrite (tabela de decisão)", () => {
	it("active → true mesmo com trial vencido", () => {
		expect(canWrite(gate("active", new Date("2020-01-01")))).toBe(true);
		expect(canWrite(gate("active", null))).toBe(true);
	});

	it("trial com trial_ends_at no futuro → true", () => {
		const future = new Date(Date.now() + 86400_000);
		expect(canWrite(gate("trial", future))).toBe(true);
	});

	it("trial com trial_ends_at no passado → false", () => {
		const past = new Date(Date.now() - 86400_000);
		expect(canWrite(gate("trial", past))).toBe(false);
	});

	it("trial com trial_ends_at null → true (legado: nunca expira)", () => {
		expect(canWrite(gate("trial", null))).toBe(true);
	});

	it("canceled e past_due → false", () => {
		expect(canWrite(gate("canceled", null))).toBe(false);
		expect(canWrite(gate("past_due", null))).toBe(false);
		expect(canWrite(gate("status-desconhecido", null))).toBe(false);
	});
});
