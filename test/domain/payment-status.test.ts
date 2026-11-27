import { describe, expect, it } from "vitest";
import {
	formatBRL,
	isValidCents,
	MAX_CENTS,
	paymentStatus,
} from "../../src/domain/payment-status.js";

describe("RF-F02 — paymentStatus", () => {
	it.each([
		[0, 0, "none", 0],
		[5000, 0, "open", 5000],
		[5000, 2000, "partial", 3000],
		[5000, 5000, "paid", 0],
		[5000, 6000, "paid", 0],
	])(
		"valor %i, recebido %i → %s (saldo %i)",
		(price, paid, status, balance) => {
			expect(paymentStatus(price, paid)).toEqual({
				price_cents: price,
				paid_cents: paid,
				balance_cents: balance,
				payment_status: status,
			});
		},
	);
});

describe("RF-F03 — isValidCents", () => {
	it("aceita inteiros de 0 ao máximo", () => {
		expect(isValidCents(0)).toBe(true);
		expect(isValidCents(MAX_CENTS)).toBe(true);
	});
	it.each([-1, 1.5, MAX_CENTS + 1, "100", null, undefined, Number.NaN])(
		"rejeita %s",
		(v) => {
			expect(isValidCents(v)).toBe(false);
		},
	);
});

describe("formatBRL", () => {
	it("formata em reais com espaço normal", () => {
		expect(formatBRL(123456)).toBe("R$ 1.234,56");
		expect(formatBRL(5)).toBe("R$ 0,05");
	});
});
