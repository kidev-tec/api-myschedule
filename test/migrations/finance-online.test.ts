/**
 * 0031 — recebimento online (F5, RF-F13). SQL real em transação desfeita.
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
	path.resolve("drizzle", "0031_finance_online_payments.sql"),
	"utf8",
);

class Rollback extends Error {}

afterAll(async () => {
	await sql.end();
});

describe("RF-F13 — 0031", () => {
	it("idempotente; situação padrão none; RLS em charges; asaas_payment_id único", async () => {
		await sql
			.begin(async (tx) => {
				await tx.unsafe(`
          DROP TABLE IF EXISTS charges;
          DROP INDEX IF EXISTS transactions_asaas_payment_uq;
          ALTER TABLE transactions DROP COLUMN IF EXISTS asaas_payment_id;
          ALTER TABLE businesses
            DROP COLUMN IF EXISTS asaas_sub_account_id,
            DROP COLUMN IF EXISTS asaas_sub_wallet_id,
            DROP COLUMN IF EXISTS asaas_sub_api_key_enc,
            DROP COLUMN IF EXISTS asaas_sub_status,
            DROP COLUMN IF EXISTS asaas_sub_updated_at;`);
				await tx.unsafe(MIGRATION);
				await tx.unsafe(MIGRATION);
				const [b] = await tx<{ id: string; s: string }[]>`
          INSERT INTO businesses (name, slug) VALUES ('Onl', ${`onl-${Date.now()}`})
          RETURNING id, asaas_sub_status AS s`;
				if (!b) throw new Error("negócio");
				expect(b.s).toBe("none");
				await expect(
					tx.savepoint(
						(sp) =>
							sp`UPDATE businesses SET asaas_sub_status = 'x' WHERE id = ${b.id}`,
					),
				).rejects.toThrow(/check constraint/);
				const ins = () =>
					tx`INSERT INTO transactions (business_id, type, amount_cents, category, asaas_payment_id)
             VALUES (${b.id}, 'income', 100, 'x', 'pay_1')`;
				await ins();
				await expect(tx.savepoint(() => ins())).rejects.toThrow(
					/transactions_asaas_payment_uq/,
				);
				const [rls] = await tx<{ on: boolean; forced: boolean }[]>`
          SELECT relrowsecurity AS on, relforcerowsecurity AS forced
          FROM pg_class WHERE relname = 'charges'`;
				expect(rls).toEqual({ on: true, forced: true });
				throw new Rollback();
			})
			.catch((e) => {
				if (!(e instanceof Rollback)) throw e;
			});
	});
});
