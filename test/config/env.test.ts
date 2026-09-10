/**
 * env.ts — coverage 100% obrigatória. Testa validação Zod fail-fast.
 */
import { describe, expect, it } from "vitest";
import { validateEnv } from "../../src/config/env.js";

const base = {
	DATABASE_URL: "postgres://localhost:5432/db",
	FIREBASE_PROJECT_ID: "meu-projeto",
};

describe("validateEnv", () => {
	it("aceita env mínima com defaults aplicados", () => {
		const env = validateEnv(base);
		expect(env.PORT).toBe(3200);
		expect(env.NODE_ENV).toBe("development");
		expect(env.CORS_ORIGINS).toBe("*");
		expect(env.FIREBASE_PROJECT_ID).toBe("meu-projeto");
	});

	it("falha sem DATABASE_URL indicando a variável", () => {
		expect(() => validateEnv({ FIREBASE_PROJECT_ID: "p" })).toThrow(
			/DATABASE_URL/,
		);
	});

	it("falha sem FIREBASE_PROJECT_ID indicando a variável", () => {
		expect(() => validateEnv({ DATABASE_URL: "postgres://x" })).toThrow(
			/FIREBASE_PROJECT_ID/,
		);
	});

	it("coerção de PORT e validação de faixa", () => {
		expect(validateEnv({ ...base, PORT: "4000" }).PORT).toBe(4000);
		expect(() => validateEnv({ ...base, PORT: "99999" })).toThrow(/PORT/);
		expect(() => validateEnv({ ...base, PORT: "abc" })).toThrow(/PORT/);
	});

	it("NODE_ENV rejeita valor fora do enum", () => {
		expect(() => validateEnv({ ...base, NODE_ENV: "staging" })).toThrow(
			/NODE_ENV/,
		);
	});

	it("mensagem de erro aponta o .env", () => {
		let msg = "";
		try {
			validateEnv({});
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).toContain(".env");
	});
});
