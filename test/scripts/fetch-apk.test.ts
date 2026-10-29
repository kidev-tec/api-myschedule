/**
 * Testes do scripts/fetch-apk.sh (publicação do APK da release na VPS).
 *
 * O script é copiado para uma árvore temporária (<tmp>/scripts/), então o
 * destino vira <tmp>/public/apks e o public/apks real não é tocado. A
 * "release" é uma pasta local servida por file:// via APK_BASE_URL.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/fetch-apk.sh");
const VERSION = "9.9.9";
const NAME = `agenva-${VERSION}.apk`;

let root: string;
let release: string;
let apks: string;

function publishRelease(content: string, checksumOf = content) {
	const apk = path.join(release, NAME);
	writeFileSync(apk, checksumOf);
	const sum = execFileSync("sha256sum", [NAME], { cwd: release })
		.toString()
		.trim();
	writeFileSync(`${apk}.sha256`, `${sum}\n`);
	writeFileSync(apk, content);
}

function run(...args: string[]) {
	return spawnSync("bash", [path.join(root, "scripts/fetch-apk.sh"), ...args], {
		env: { ...process.env, APK_BASE_URL: `file://${release}` },
		encoding: "utf8",
	});
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "fetch-apk-"));
	release = path.join(root, "release");
	apks = path.join(root, "public/apks");
	mkdirSync(path.join(root, "scripts"));
	mkdirSync(release);
	copyFileSync(SCRIPT, path.join(root, "scripts/fetch-apk.sh"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("scripts/fetch-apk.sh", () => {
	it("publica o APK quando o sha256 confere", () => {
		publishRelease("apk-v999");
		const r = run(VERSION);
		expect(r.status).toBe(0);
		expect(readFileSync(path.join(apks, NAME), "utf8")).toBe("apk-v999");
		// sem sobra do diretório temporário
		expect(readdirSync(apks)).toEqual([NAME]);
	});

	it("checksum errado → falha e não publica nada", () => {
		publishRelease("apk-adulterado", "apk-original");
		const r = run(VERSION);
		expect(r.status).not.toBe(0);
		expect(existsSync(path.join(apks, NAME))).toBe(false);
		expect(readdirSync(apks)).toEqual([]);
	});

	it("APK já publicado é preservado (nunca sobrescreve)", () => {
		publishRelease("apk-novo");
		mkdirSync(apks, { recursive: true });
		writeFileSync(path.join(apks, NAME), "apk-existente");
		const r = run(VERSION);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("já existe");
		expect(readFileSync(path.join(apks, NAME), "utf8")).toBe("apk-existente");
	});

	it("versão inválida → uso, sem baixar", () => {
		const r = run("1.4");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("uso:");
		expect(existsSync(apks)).toBe(false);
	});
});
