/**
 * Criptografia AES-256-GCM pra tokens OAuth em repouso (B9).
 *
 * Chave: GCAL_ENC_KEY (32 bytes hex/base64/utf8 → derivada com sha256).
 * Formato armazenado: base64(iv[12] | authTag[16] | ciphertext).
 * Sem GCAL_ENC_KEY configurada: encrypt = plaintext, decrypt = passthrough
 * (modo legado de dev; em prod a env é obrigatória).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKey(): Buffer | null {
	const secret = process.env.GCAL_ENC_KEY;
	if (!secret) return null;
	// normaliza qualquer tamanho de secret pra 32 bytes
	return createHash("sha256").update(secret).digest();
}

export function encryptToken(plaintext: string): string {
	const key = deriveKey();
	if (!key) return plaintext; // dev sem chave: plaintext (legado)
	const iv = randomBytes(IV_LEN);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptToken(stored: string): string {
	const key = deriveKey();
	if (!key) return stored; // dev sem chave: passthrough
	try {
		const raw = Buffer.from(stored, "base64");
		const iv = raw.subarray(0, IV_LEN);
		const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
		const enc = raw.subarray(IV_LEN + TAG_LEN);
		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
			"utf8",
		);
	} catch {
		// valor legado em plaintext (anterior à chave) → devolve como está
		return stored;
	}
}

export function isEncrypted(stored: string): boolean {
	// heurística: base64 decodificável com tamanho >= iv+tag+1 e sem espaços
	if (!process.env.GCAL_ENC_KEY) return false;
	const raw = Buffer.from(stored, "base64");
	return raw.length >= IV_LEN + TAG_LEN + 1;
}
