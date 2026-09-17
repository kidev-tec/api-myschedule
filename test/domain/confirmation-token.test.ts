import { afterEach, describe, expect, it } from "vitest";
import {
	confirmationToken,
	verifyConfirmationToken,
} from "../../src/domain/confirmation-token.js";

describe("confirmationToken", () => {
	const id = "11111111-1111-4111-8111-111111111111";
	const startsAt = new Date("2030-01-15T12:00:00.000Z");
	const saved = process.env.DATABASE_URL;

	afterEach(() => {
		if (saved === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = saved;
	});

	it("usa pepper explícito e valida em constant-time", () => {
		const token = confirmationToken(id, startsAt, "pepper-teste");
		expect(token).toHaveLength(64);
		expect(verifyConfirmationToken(id, startsAt, token, "pepper-teste")).toBe(
			true,
		);
		expect(verifyConfirmationToken(id, startsAt, "x".repeat(64))).toBe(false);
	});

	it("fallback agenva-dev-pepper quando DATABASE_URL ausente", () => {
		delete process.env.DATABASE_URL;
		const a = confirmationToken(id, startsAt);
		const b = confirmationToken(id, startsAt, "agenva-dev-pepper");
		expect(a).toBe(b);
	});
});
