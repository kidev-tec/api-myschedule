import postgres from "postgres";
import { describe, expect, it } from "vitest";

/**
 * RF-segurança (0008): RLS fail-closed em TODAS as tabelas.
 * Regressão: se alguém criar tabela nova sem RLS, ou desligar FORCE,
 * este teste quebra. A API (superuser) bypassa RLS — fluxos não mudam.
 *
 * Conecta como superuser (mesma credencial da API) mas consulta o CATÁLOGO
 * (pg_class/pg_policies), não os dados — o catálogo não é afetado por RLS.
 */
describe("RLS fail-closed (migration 0008)", () => {
	const DATABASE_URL =
		process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
	const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 5 });

	it("todas as tabelas public têm RLS + FORCE ativos", async () => {
		const missing = await sql`
      SELECT relname FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
        AND relname <> '_migrations'
        AND NOT (relrowsecurity AND relforcerowsecurity)`;
		expect(
			missing.map((r) => r.relname),
			"tabelas sem RLS+FORCE — rode a migration 0008 na base de teste",
		).toEqual([]);
	});

	it("nenhuma policy pública existe (whitelist implícita — fail-closed)", async () => {
		const policies = await sql`
      SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public'`;
		// Se uma policy for criada no futuro, deve ser revisada e este teste
		// atualizado conscientemente (Spec Update Gate).
		expect(
			policies.map((r) => `${r.tablename}:${r.policyname}`),
			"policies inesperadas — revisar com o time antes de manter",
		).toEqual([]);

		await sql.end();
	});
});
