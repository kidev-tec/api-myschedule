/**
 * 0029 — metas mensais (TASK-F3-02, RF-F10). SQL real em transação desfeita.
 */
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
const MIGRATION = fs.readFileSync(
	path.resolve("drizzle", "0029_finance_goals.sql"),
	"utf8",
);

class Rollback extends Error {}

afterAll(async () => {
	await sql.end();
});

describe("RF-F10 — 0029 financial_goals", () => {
	it("idempotente, RLS e constraints (dia 1, valor > 0, 1 por mês)", async () => {
		await sql
			.begin(async (tx) => {
				await tx.unsafe("DROP TABLE IF EXISTS financial_goals");
				await tx.unsafe(MIGRATION);
				await tx.unsafe(MIGRATION);
				const [b] = await tx<{ id: string }[]>`
          INSERT INTO businesses (name, slug)
          VALUES ('Meta', ${`meta-${Date.now()}`}) RETURNING id`;
				if (!b) throw new Error("negócio");
				await tx`INSERT INTO financial_goals (business_id, month, target_cents) VALUES (${b.id}, '2026-11-01', 100)`;
				for (const [month, target, re] of [
					["2026-11-15", 100, /check constraint/],
					["2026-12-01", 0, /check constraint/],
					["2026-11-01", 200, /duplicate key/],
				] as const) {
					await expect(
						tx.savepoint(
							(sp) =>
								sp`INSERT INTO financial_goals (business_id, month, target_cents) VALUES (${b.id}, ${month}, ${target})`,
						),
					).rejects.toThrow(re);
				}
				const [rls] = await tx<{ on: boolean; forced: boolean }[]>`
          SELECT relrowsecurity AS on, relforcerowsecurity AS forced
          FROM pg_class WHERE relname = 'financial_goals'`;
				expect(rls).toEqual({ on: true, forced: true });
				throw new Rollback();
			})
			.catch((e) => {
				if (!(e instanceof Rollback)) throw e;
			});
	});
});
