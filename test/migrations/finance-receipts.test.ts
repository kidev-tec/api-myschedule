/**
 * 0030 — número do comprovante (TASK-F4-02, RF-F12). SQL real, desfeito.
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
	path.resolve("drizzle", "0030_finance_receipts.sql"),
	"utf8",
);

class Rollback extends Error {}

afterAll(async () => {
	await sql.end();
});

describe("RF-F12 — 0030 receipt_number", () => {
	it("idempotente; número único por negócio (nulos livres)", async () => {
		await sql
			.begin(async (tx) => {
				await tx.unsafe(`
          DROP INDEX IF EXISTS transactions_receipt_number_uq;
          ALTER TABLE transactions DROP COLUMN IF EXISTS receipt_number;`);
				await tx.unsafe(MIGRATION);
				await tx.unsafe(MIGRATION);
				const biz = async (n: string) => {
					const [b] = await tx<{ id: string }[]>`
            INSERT INTO businesses (name, slug)
            VALUES (${n}, ${`${n}-${Date.now()}`}) RETURNING id`;
					if (!b) throw new Error("negócio");
					return b.id;
				};
				const a = await biz("rc-a");
				const b = await biz("rc-b");
				const ins = (bizId: string, n: number | null) =>
					tx`INSERT INTO transactions (business_id, type, amount_cents, category, receipt_number)
             VALUES (${bizId}, 'income', 100, 'x', ${n})`;
				await ins(a, 1);
				await ins(a, null);
				await ins(a, null);
				await ins(b, 1);
				await expect(tx.savepoint(() => ins(a, 1))).rejects.toThrow(
					/transactions_receipt_number_uq/,
				);
				throw new Rollback();
			})
			.catch((e) => {
				if (!(e instanceof Rollback)) throw e;
			});
		expect(true).toBe(true);
	});
});
