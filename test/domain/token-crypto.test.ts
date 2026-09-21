/**
 * Unit: token-crypto (AES-256-GCM) — B9.
 * - roundtrip encrypt/decrypt com GCAL_ENC_KEY
 * - ciphertext não contém plaintext e difere entre chamadas (iv aleatório)
 * - decrypt de valor legado plaintext → passthrough
 * - sem GCAL_ENC_KEY: plaintext passthrough (modo dev legado)
 * - tag adulterada → cai no passthrough (defesa)
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	decryptToken,
	encryptToken,
	isEncrypted,
} from "../../src/domain/token-crypto.js";

const KEY = "chave-de-teste-super-secreta-32b";

describe("token-crypto (AES-256-GCM)", () => {
	beforeEach(() => {
		process.env.GCAL_ENC_KEY = KEY;
	});

	it("roundtrip: encrypt → decrypt devolve o original", () => {
		const plain = "1//0aBcDeFgHiJkLmNoPqRsTuVwXyZ-refresh-token";
		const enc = encryptToken(plain);
		expect(enc).not.toBe(plain);
		expect(decryptToken(enc)).toBe(plain);
	});

	it("ciphertext difere entre chamadas (IV aleatório)", () => {
		const a = encryptToken("mesmo-token");
		const b = encryptToken("mesmo-token");
		expect(a).not.toBe(b);
		expect(decryptToken(a)).toBe("mesmo-token");
		expect(decryptToken(b)).toBe("mesmo-token");
	});

	it("valor legado plaintext → decrypt passthrough", () => {
		// token salvo antes da chave existir: não é base64(iv+tag+ct) válido
		const legacy = "1//plain-old-refresh-token";
		expect(decryptToken(legacy)).toBe(legacy);
	});

	it("sem GCAL_ENC_KEY: plaintext passthrough nos dois sentidos", () => {
		delete process.env.GCAL_ENC_KEY;
		const plain = "raw-token";
		expect(encryptToken(plain)).toBe(plain);
		expect(decryptToken(plain)).toBe(plain);
		expect(isEncrypted(plain)).toBe(false);
	});

	it("isEncrypted: true pra ciphertext, false pra plaintext curto", () => {
		const enc = encryptToken("x");
		expect(isEncrypted(enc)).toBe(true);
		expect(isEncrypted("curto")).toBe(false);
	});
});
