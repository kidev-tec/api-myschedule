/**
 * Testes do scripts/fetch-apk.sh (publicação de uma release do app na VPS).
 *
 * O script é copiado para uma árvore temporária (<tmp>/scripts/), então o
 * destino vira <tmp>/public e o public/ real não é tocado. A "release" é uma
 * pasta local servida por file:// via APK_BASE_URL, com os mesmos assets que
 * o release.yml do app publica: APK, manifesto e .sha256 dos dois.
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
const MANIFEST = `agenva-${VERSION}.version.json`;
const SUMS = `agenva-${VERSION}.sha256`;
const OLD_MANIFEST = '{"version":"1.0.0"}';

let root: string;
let release: string;
let pub: string;
let apks: string;

function manifest(version = VERSION, apk = NAME) {
	return JSON.stringify({
		version,
		apk_url: `/apks/${apk}`,
		changelog: "Novidades da versão",
	});
}

/** Monta a release; `tamper` troca o conteúdo DEPOIS do checksum. */
function publishRelease(
	opts: { apk?: string; manifest?: string; tamper?: "apk" | "manifest" } = {},
) {
	writeFileSync(path.join(release, NAME), opts.apk ?? "apk-v999");
	writeFileSync(path.join(release, MANIFEST), opts.manifest ?? manifest());
	const sums = execFileSync("sha256sum", [NAME, MANIFEST], { cwd: release });
	writeFileSync(path.join(release, SUMS), sums);
	if (opts.tamper === "apk") writeFileSync(path.join(release, NAME), "x");
	if (opts.tamper === "manifest") {
		writeFileSync(path.join(release, MANIFEST), manifest("6.6.6"));
	}
}

function run(...args: string[]) {
	return spawnSync("bash", [path.join(root, "scripts/fetch-apk.sh"), ...args], {
		env: { ...process.env, APK_BASE_URL: `file://${release}` },
		encoding: "utf8",
	});
}

const versionJson = () => readFileSync(path.join(pub, "version.json"), "utf8");

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "fetch-apk-"));
	release = path.join(root, "release");
	pub = path.join(root, "public");
	apks = path.join(pub, "apks");
	mkdirSync(path.join(root, "scripts"));
	mkdirSync(release);
	mkdirSync(pub);
	writeFileSync(path.join(pub, "version.json"), OLD_MANIFEST);
	copyFileSync(SCRIPT, path.join(root, "scripts/fetch-apk.sh"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("scripts/fetch-apk.sh", () => {
	it("publica o APK e troca o version.json pelo manifesto da release", () => {
		publishRelease();
		const r = run(VERSION);
		expect(r.status).toBe(0);
		expect(readFileSync(path.join(apks, NAME), "utf8")).toBe("apk-v999");
		expect(JSON.parse(versionJson())).toEqual({
			version: VERSION,
			apk_url: `/apks/${NAME}`,
			changelog: "Novidades da versão",
		});
		// sem sobra do diretório temporário
		expect(readdirSync(apks)).toEqual([NAME]);
	});

	it("checksum do APK errado → não publica nem troca o version.json", () => {
		publishRelease({ tamper: "apk" });
		const r = run(VERSION);
		expect(r.status).not.toBe(0);
		expect(existsSync(path.join(apks, NAME))).toBe(false);
		expect(readdirSync(apks)).toEqual([]);
		expect(versionJson()).toBe(OLD_MANIFEST);
	});

	it("checksum do manifesto errado → nada muda", () => {
		publishRelease({ tamper: "manifest" });
		const r = run(VERSION);
		expect(r.status).not.toBe(0);
		expect(existsSync(path.join(apks, NAME))).toBe(false);
		expect(versionJson()).toBe(OLD_MANIFEST);
	});

	it("manifesto de outra versão → recusa, mesmo com checksum válido", () => {
		publishRelease({ manifest: manifest("6.6.6", "agenva-6.6.6.apk") });
		const r = run(VERSION);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("não aponta");
		expect(existsSync(path.join(apks, NAME))).toBe(false);
		expect(versionJson()).toBe(OLD_MANIFEST);
	});

	it("manifesto formatado (JSON com espaços) → publica igual ao compacto", () => {
		const pretty = JSON.stringify(JSON.parse(manifest()), null, 2);
		publishRelease({ manifest: pretty });
		const r = run(VERSION);
		expect(r.status).toBe(0);
		expect(readFileSync(path.join(apks, NAME), "utf8")).toBe("apk-v999");
		expect(versionJson()).toBe(pretty);
	});

	it("versão só parecida (ponto não é curinga) → recusa", () => {
		publishRelease({ manifest: manifest("9x9x9", NAME) });
		const r = run(VERSION);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("não aponta");
		expect(versionJson()).toBe(OLD_MANIFEST);
	});

	it("APK já publicado e igual à release → mantém e só troca o version.json", () => {
		publishRelease();
		mkdirSync(apks, { recursive: true });
		writeFileSync(path.join(apks, NAME), "apk-v999");
		const r = run(VERSION);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("já publicado");
		expect(JSON.parse(versionJson()).version).toBe(VERSION);
	});

	it("APK já existente e diferente da release → nunca sobrescreve, version.json intacto", () => {
		publishRelease();
		mkdirSync(apks, { recursive: true });
		writeFileSync(path.join(apks, NAME), "apk-de-outra-origem");
		const r = run(VERSION);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("difere da release");
		expect(readFileSync(path.join(apks, NAME), "utf8")).toBe(
			"apk-de-outra-origem",
		);
		expect(versionJson()).toBe(OLD_MANIFEST);
	});

	it("versão inválida → uso, sem baixar", () => {
		const r = run("1.4");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("uso:");
		expect(existsSync(apks)).toBe(false);
		expect(versionJson()).toBe(OLD_MANIFEST);
	});
});
