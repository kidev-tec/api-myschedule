import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// RF-D4 / PLAN-devops §7: paridade entre .env.example e variáveis realmente
// consumidas pelo código (src/**, scripts/**). Falha se faltar var documentada
// ou se sobrar var documentada nunca usada. Não imprime valores, só nomes.
const ROOT = resolve(__dirname, "../..");

function listSourceEnvVars(): Set<string> {
	const vars = new Set<string>();
	const dirs = ["src", "scripts"];
	for (const dir of dirs) {
		execGrep(dir, vars);
	}
	return vars;
}

function execGrep(dir: string, vars: Set<string>): void {
	// Padrão 1: process.env.X (uso direto)
	const out = execFileSync(
		"grep",
		["-rhoE", String.raw`process\.env\.[A-Z_0-9]+`, "-r", dir],
		{ cwd: ROOT, encoding: "utf8" },
	);
	for (const m of out.matchAll(/process\.env\.([A-Z_0-9]+)/g)) {
		const name = m[1];
		if (name) vars.add(name);
	}
	// Padrão 2: getEnv().X / env.X (env validada por Zod em src/config/env.ts)
	const out2 = execFileSync(
		"grep",
		["-rhoE", String.raw`(getEnv\(\)|[^a-zA-Z])env\.[A-Z_0-9]{4,}`, "-r", dir],
		{ cwd: ROOT, encoding: "utf8" },
	);
	for (const m of out2.matchAll(/env\.([A-Z_0-9]{4,})/g)) {
		const name = m[1];
		if (name) vars.add(name);
	}
	// Padrão 3: chaves do schema Zod em src/config/env.ts
	try {
		const envTs = readFileSync(resolve(ROOT, "src/config/env.ts"), "utf8");
		for (const m of envTs.matchAll(/^\s+([A-Z_0-9]{4,}):\s*z\./gm)) {
			const name = m[1];
			if (name) vars.add(name);
		}
	} catch {
		// arquivo pode não existir em outros projetos
	}
}

function listExampleVars(): Set<string> {
	const content = readFileSync(resolve(ROOT, ".env.example"), "utf8");
	const vars = new Set<string>();
	for (const m of content.matchAll(/^([A-Z_0-9]+)=/gm)) {
		const name = m[1];
		if (name) vars.add(name);
	}
	return vars;
}

describe("RF-D4: paridade .env.example ↔ código", () => {
	const codeVars = listSourceEnvVars();
	const exampleVars = listExampleVars();

	it("toda var consumida no código está documentada no .env.example", () => {
		const missing = [...codeVars].filter((v) => !exampleVars.has(v));
		// TZ é do runtime (docker/systemd), não da app — não precisa estar no example
		const allowedMissing = new Set(["TZ"]);
		expect(
			missing.filter((v) => !allowedMissing.has(v)),
			`Variáveis sem documentação em .env.example: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("toda var documentada no .env.example é consumida (ou é infra de staging)", () => {
		const infraOnly = new Set([
			"POSTGRES_PASSWORD",
			"POSTGRES_PASSWORD_URLENCODED",
			"CORS_ORIGINS_STAGING",
			"DIRECT_URL", // consumida por scripts/run-migrations.mjs via docs
			"TEST_DATABASE_URL", // forçada pelo vitest.config.ts (localhost:5433)
			"GCAL_CLIENT_ID", // OAuth consent flow — usada via redirect/callback, não lida em src
			"GCAL_CLIENT_SECRET", // idem
			"GCAL_REDIRECT_URI", // idem
		]);
		const unused = [...exampleVars].filter(
			(v) => !codeVars.has(v) && !infraOnly.has(v),
		);
		expect(
			unused,
			`Variáveis no .env.example que o código não usa: ${unused.join(", ")}`,
		).toEqual([]);
	});
});
