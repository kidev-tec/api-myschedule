/**
 * Testes do updater (GET /version + leitura de version.json).
 */

import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
	APP_VERSION_FILE,
	parseVersionFile,
	readAppVersion,
	versionRoutes,
} from "../../src/routes/version.js";

afterEach(() => {
	// restaura o version.json real (testes escreveram nele)
	writeFileSync(
		APP_VERSION_FILE,
		JSON.stringify({
			version: "1.0.0",
			apk_url: "/apks/minha-agenda.apk",
			changelog:
				"Primeira versão com link público de agendamento, multi-segmento e paywall.",
		}),
	);
});

describe("updater: GET /version", () => {
	it("retorna versão lida de public/version.json", async () => {
		// grava arquivo de teste no caminho real (restaurado pelo afterEach via git)
		const app = versionRoutes();
		const res = await app.request("/version");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { version: string; apk_url: string };
		expect(body.version).toBeTruthy();
		expect(body.apk_url).toContain("/apks/");
	});

	it("readAppVersion: lê JSON válido", () => {
		writeFileSync(
			APP_VERSION_FILE,
			JSON.stringify({
				version: "9.9.9",
				apk_url: "/apks/x.apk",
				changelog: "t",
			}),
		);
		const v = readAppVersion();
		expect(v.version).toBe("9.9.9");
		expect(v.apk_url).toBe("/apks/x.apk");
	});

	it("readAppVersion: JSON com campos faltantes → fallbacks campo a campo", () => {
		// só apk_url: cai no ?? de version e changelog
		writeFileSync(APP_VERSION_FILE, JSON.stringify({ apk_url: "/apks/x.apk" }));
		const v = readAppVersion();
		expect(v.version).toBe("0.0.0");
		expect(v.apk_url).toBe("/apks/x.apk");
		expect(v.changelog).toBe("");
		// só changelog: cai no ?? de version e apk_url
		writeFileSync(APP_VERSION_FILE, JSON.stringify({ changelog: "oi" }));
		const v2 = readAppVersion();
		expect(v2.version).toBe("0.0.0");
		expect(v2.apk_url).toBe("/apks/minha-agenda.apk");
		expect(v2.changelog).toBe("oi");
	});

	it("GET /apks/* serve o APK estático (integração app.ts)", async () => {
		// precisa do createApp real — mock Firebase como nos outros testes de rota
		const { vi } = await import("vitest");
		vi.doMock("firebase-admin/auth", () => ({
			getAuth: () => ({ verifyIdToken: async () => ({ uid: "x" }) }),
		}));
		vi.doMock("firebase-admin/app", () => ({
			getApps: vi.fn(() => [{} as never]),
		}));
		const { createApp } = await import("../../src/app.js");
		const app = createApp({
			databaseUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!,
			firebaseProjectId: "t",
		});
		const res = await app.request("/apks/test.apk");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("apk-fake");
	});

	it("readAppVersion: arquivo não existe → default", () => {
		const v = parseVersionFile("/tmp/nao-existe-version.json");
		expect(v.version).toBe("0.0.0");
		expect(v.apk_url).toBe("/apks/minha-agenda.apk");
	});

	it("readAppVersion: JSON corrompido → default sem crash", () => {
		writeFileSync(APP_VERSION_FILE, "{quebrado");
		const v = readAppVersion();
		expect(v.version).toBe("0.0.0");
	});
});
