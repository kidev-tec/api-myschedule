/**
 * Updater do app (distribuição direta — Opção A).
 *
 * GET /version → { version, apk_url, changelog }
 * O app compara com a versão local e mostra banner "atualizar".
 *
 * O APK release fica em public/apks/minha-agenda.apk (substituído a cada
 * release pelo CI ou manualmente). versionFile é version.json no mesmo
 * diretório — editar sem rebuild da API.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";

/** Caminho do version.json — overridável em testes. */
export const APP_VERSION_FILE =
	process.env.APP_VERSION_FILE ?? path.resolve("public/version.json");

/** Lê e normaliza um version.json de um caminho qualquer. */
export function parseVersionFile(file: string): {
	version: string;
	apk_url: string;
	changelog: string;
} {
	try {
		if (existsSync(file)) {
			const raw = JSON.parse(readFileSync(file, "utf8")) as {
				version?: string;
				apk_url?: string;
				changelog?: string;
			};
			return {
				version: raw.version ?? "0.0.0",
				apk_url: raw.apk_url ?? "/apks/minha-agenda.apk",
				changelog: raw.changelog ?? "",
			};
		}
	} catch {
		// arquivo corrompido → default
	}
	return { version: "0.0.0", apk_url: "/apks/minha-agenda.apk", changelog: "" };
}

/** Lê public/version.json a cada request (editável sem restart). */
export function readAppVersion(): {
	version: string;
	apk_url: string;
	changelog: string;
} {
	return parseVersionFile(APP_VERSION_FILE);
}

export function versionRoutes() {
	const routes = new Hono();

	routes.get("/version", (c) => c.json(readAppVersion()));

	return routes;
}
