/**
 * 0028 — caixa diário e despesas (TASK-F2-01, RF-F05/RF-F06).
 * SQL real da migration em transação desfeita (nada fica no banco).
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
	path.resolve("drizzle", "0028_finance_cash_expenses.sql"),
	"utf8",
);

class Rollback extends Error {}
type Tx = postgres.TransactionSql;

function one<T>(rows: readonly T[]): T {
	const [row] = rows;
	if (row === undefined) throw new Error("consulta sem linhas");
	return row;
}

async function inRollback(fn: (tx: Tx) => Promise<void>) {
	await sql
		.begin(async (tx) => {
			await fn(tx);
			throw new Rollback();
		})
		.catch((e) => {
			if (!(e instanceof Rollback)) throw e;
		});
}

/** Estado pré-0028. */
async function pre0028(tx: Tx) {
	await tx.unsafe(`
    ALTER TABLE transactions
      DROP COLUMN IF EXISTS cash_session_id,
      DROP COLUMN IF EXISTS paid,
      DROP COLUMN IF EXISTS due_at;
    DROP INDEX IF EXISTS transactions_business_type_idx;
    DROP TABLE IF EXISTS cash_sessions;
  `);
}

let seq = 0;
async function owner(tx: Tx) {
	const tag = `${Date.now()}-${seq++}`;
	const b = one(
		await tx<{ id: string }[]>`
      INSERT INTO businesses (name, slug) VALUES (${`Cx ${tag}`}, ${`cx-${tag}`}) RETURNING id`,
	);
	const u = one(
		await tx<{ id: string }[]>`
      INSERT INTO users (business_id, firebase_uid, email, name)
      VALUES (${b.id}, ${`cx-${tag}`}, ${`cx-${tag}@t.dev`}, 'Pro') RETURNING id`,
	);
	return { businessId: b.id, userId: u.id };
}

afterAll(async () => {
	await sql.end();
});

describe("RF-F05/RF-F06 — 0028 caixa e despesas", () => {
	it("idempotente e com defaults", async () => {
		await inRollback(async (tx) => {
			await pre0028(tx);
			await tx.unsafe(MIGRATION);
			await tx.unsafe(MIGRATION);
			const o = await owner(tx);
			const cs = one(
				await tx<
					{ id: string; opening_cents: number; closed_at: Date | null }[]
				>`
          INSERT INTO cash_sessions (business_id, opened_by)
          VALUES (${o.businessId}, ${o.userId}) RETURNING id, opening_cents, closed_at`,
			);
			expect(cs.opening_cents).toBe(0);
			expect(cs.closed_at).toBeNull();
			const t = one(
				await tx<
					{ paid: boolean; due_at: Date | null; cash_session_id: string }[]
				>`
          INSERT INTO transactions (business_id, type, amount_cents, category, cash_session_id)
          VALUES (${o.businessId}, 'expense', 100, 'aluguel', ${cs.id})
          RETURNING paid, due_at, cash_session_id`,
			);
			expect(t).toEqual({ paid: true, due_at: null, cash_session_id: cs.id });
			const rls = one(
				await tx<{ on: boolean; forced: boolean }[]>`
          SELECT relrowsecurity AS on, relforcerowsecurity AS forced
          FROM pg_class WHERE relname = 'cash_sessions'`,
			);
			expect(rls).toEqual({ on: true, forced: true });
		});
	});

	it("no máximo 1 caixa aberto por negócio", async () => {
		await inRollback(async (tx) => {
			await pre0028(tx);
			await tx.unsafe(MIGRATION);
			const o = await owner(tx);
			await tx`INSERT INTO cash_sessions (business_id, opened_by) VALUES (${o.businessId}, ${o.userId})`;
			await expect(
				tx.savepoint(
					(sp) =>
						sp`INSERT INTO cash_sessions (business_id, opened_by) VALUES (${o.businessId}, ${o.userId})`,
				),
			).rejects.toThrow(/cash_sessions_one_open_idx/);
			// fechado o primeiro, abrir outro é aceito
			await tx`UPDATE cash_sessions SET closed_at = now() WHERE business_id = ${o.businessId}`;
			await tx`INSERT INTO cash_sessions (business_id, opened_by) VALUES (${o.businessId}, ${o.userId})`;
			const n = one(
				await tx<
					{ n: number }[]
				>`SELECT count(*)::int AS n FROM cash_sessions WHERE business_id = ${o.businessId}`,
			);
			expect(n.n).toBe(2);
		});
	});

	it.each([
		["saldo inicial negativo", "opening_cents", "-1"],
		["contado negativo", "counted_cents", "-1"],
	])("rejeita %s", async (_l, column, value) => {
		await inRollback(async (tx) => {
			await pre0028(tx);
			await tx.unsafe(MIGRATION);
			const o = await owner(tx);
			await expect(
				tx.savepoint((sp) =>
					sp.unsafe(
						`INSERT INTO cash_sessions (business_id, opened_by, ${column})
             VALUES ('${o.businessId}', '${o.userId}', ${value})`,
					),
				),
			).rejects.toThrow(/violates check constraint/);
		});
	});
});
