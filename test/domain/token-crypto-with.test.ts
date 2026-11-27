import { describe, expect, it } from "vitest";
import { decryptWith, encryptWith } from "../../src/domain/token-crypto.js";

describe("RF-F13 — cifra das chaves das subcontas (encryptWith/decryptWith)", () => {
	it("roundtrip; texto cifrado não contém a chave e muda a cada vez", () => {
		const a = encryptWith("segredo", "$aact_chave_da_subconta");
		const b = encryptWith("segredo", "$aact_chave_da_subconta");
		expect(a).not.toContain("aact");
		expect(a).not.toBe(b);
		expect(decryptWith("segredo", a)).toBe("$aact_chave_da_subconta");
	});

	it("segredo errado ou valor adulterado lança (sem texto puro)", () => {
		const enc = encryptWith("segredo", "x");
		expect(() => decryptWith("outro", enc)).toThrow();
		expect(() => decryptWith("segredo", "texto-puro")).toThrow();
	});
});
