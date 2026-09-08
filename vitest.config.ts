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
      exclude: ["src/db/migrations/**", "**/*.d.ts"],
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
