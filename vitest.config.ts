import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Resolve imports TS ESM (Node16) com sufixo .js apontando para o .ts real.
 * Equivalente ao moduleNameMapper de jest: '^(\\.{1,2}/.*)\\.js$': '$1'
 */
function jsToTsPlugin() {
  return {
    name: "js-to-ts",
    enforce: "pre" as const,
    resolveId(this: { resolve?: (...args: unknown[]) => unknown }, source: string, importer: string | undefined) {
      if (!importer || !source.startsWith(".")) return null;
      if (!source.endsWith(".js")) return null;
      const stripped = source.slice(0, -3);
      const resolved = path.resolve(path.dirname(importer), `${stripped}.ts`);
      return this.resolve?.(resolved, importer, { skipSelf: true }) ?? null;
    },
  };
}

const LOCAL_TEST_DB =
  "postgres://postgres:dev@localhost:5433/minha_agenda_dev";

function loadTestEnv() {
  try {
    const raw = fs.readFileSync(".env", "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      // Não herdar DATABASE_URL / TEST_DATABASE_URL do .env (Supabase) nem do shell
      if (
        m?.[1] &&
        m[1] !== "DATABASE_URL" &&
        m[1] !== "TEST_DATABASE_URL" &&
        m[1] !== "DIRECT_URL" &&
        !process.env[m[1]]
      ) {
        process.env[m[1]] = m[2];
      }
    }
  } catch {
    /* .env opcional */
  }
  // Testes SEMPRE no Postgres local (mesmo do CI) — ignora shell/Supabase
  process.env.TEST_DATABASE_URL = LOCAL_TEST_DB;
  process.env.DATABASE_URL = LOCAL_TEST_DB;
}
loadTestEnv();

export default defineConfig({
  plugins: [jsToTsPlugin()],
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Postgres de teste: serial para evitar conflito de schema entre arquivos
    fileParallelism: false,
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      // migrations: geradas. schema.ts: declarações de tabela Drizzle sem
      // lógica — linhas executadas só no import (falso negativo de coverage).
      exclude: ["src/db/migrations/**", "src/db/schema.ts", "src/index.ts", "src/types.ts", "**/*.d.ts"],
      // RNF QUALIDADE (Rafael, 09/09/2026): 100% em TUDO — sem exceção
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
