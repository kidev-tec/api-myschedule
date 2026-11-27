/**
 * 0027 — preço no agendamento + livro-caixa (TASK-F1-01, RF-F01/F02/F03).
 * Cada caso roda dentro de uma transação desfeita no fim: volta o schema para
 * o estado pré-0027 (DROP das colunas novas), insere dados, aplica o SQL real
 * da migration (2x, idempotência) e confere. Nada fica no banco de teste.
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
	path.resolve("drizzle", "0027_finance_payments.sql"),
	"utf8",
);

class Rollback extends Error {}

/** 1ª linha do resultado (falha o teste se vier vazio). */
function one<T>(rows: readonly T[]): T {
	const [row] = rows;
	if (row === undefined) throw new Error("consulta sem linhas");
	return row;
}

type Tx = postgres.TransactionSql;

/** Executa fn numa transação que SEMPRE é desfeita. */
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

/** Estado pré-0027: remove o que a migration cria. */
async function pre0027(tx: Tx) {
	await tx.unsafe(`
    ALTER TABLE appointments DROP COLUMN IF EXISTS price_cents;
    ALTER TABLE transactions
      DROP CONSTRAINT IF EXISTS transactions_amount_positive,
      DROP COLUMN IF EXISTS payment_method,
      DROP COLUMN IF EXISTS installments,
      DROP COLUMN IF EXISTS kind,
      DROP COLUMN IF EXISTS client_id,
      DROP COLUMN IF EXISTS created_by_user_id,
      DROP COLUMN IF EXISTS voided_at,
      DROP COLUMN IF EXISTS created_at;
    DROP INDEX IF EXISTS transactions_appointment_idx;
  `);
}

let seq = 0;
async function fixtures(tx: Tx) {
	const tag = `${Date.now()}-${seq++}`;
	const b = one(
		await tx<{ id: string }[]>`
    INSERT INTO businesses (name, slug) VALUES (${`Fin ${tag}`}, ${`fin-${tag}`})
    RETURNING id`,
	);
	const u = one(
		await tx<{ id: string }[]>`
    INSERT INTO users (business_id, firebase_uid, email, name)
    VALUES (${b.id}, ${`uid-${tag}`}, ${`fin-${tag}@t.dev`}, 'Pro')
    RETURNING id`,
	);
	const c = one(
		await tx<{ id: string }[]>`
    INSERT INTO clients (business_id, name, phone_e164)
    VALUES (${b.id}, 'Cliente', '+5511999990000') RETURNING id`,
	);
	const s = one(
		await tx<{ id: string }[]>`
    INSERT INTO services (business_id, name, duration_min, price_cents)
    VALUES (${b.id}, 'Corte', 30, 8000) RETURNING id`,
	);
	const appt = async (startsAt: string, source = "app") => {
		const a = one(
			await tx<{ id: string }[]>`
      INSERT INTO appointments (business_id, client_id, service_id, user_id, starts_at, ends_at, source)
      VALUES (${b.id}, ${c.id}, ${s.id}, ${u.id}, ${startsAt},
              ${startsAt}::timestamptz + interval '30 minutes', ${source})
      RETURNING id`,
		);
		return a.id;
	};
	return { businessId: b.id, serviceId: s.id, appt };
}

async function priceOf(tx: Tx, id: string) {
	const r = one(
		await tx<
			{ price_cents: number }[]
		>`SELECT price_cents FROM appointments WHERE id = ${id}`,
	);
	return r.price_cents;
}

afterAll(async () => {
	await sql.end();
});

describe("RF-F03 — 0027 snapshot do preço no agendamento", () => {
	it("backfill: agendamento recebe o preço atual do serviço; bloqueio fica 0", async () => {
		await inRollback(async (tx) => {
			await pre0027(tx);
			const f = await fixtures(tx);
			const normal = await f.appt("2030-01-10T12:00:00Z");
			const block = await f.appt("2030-01-10T14:00:00Z", "block");

			await tx.unsafe(MIGRATION);

			expect(await priceOf(tx, normal)).toBe(8000);
			expect(await priceOf(tx, block)).toBe(0);
		});
	});

	it("idempotente: rodar 2x não falha nem sobrescreve valor editado", async () => {
		await inRollback(async (tx) => {
			await pre0027(tx);
			const f = await fixtures(tx);
			const id = await f.appt("2030-01-11T12:00:00Z");
			await tx.unsafe(MIGRATION);
			await tx`UPDATE appointments SET price_cents = 6500 WHERE id = ${id}`;
			await tx`UPDATE services SET price_cents = 9900 WHERE id = ${f.serviceId}`;

			await tx.unsafe(MIGRATION);

			expect(await priceOf(tx, id)).toBe(6500);
		});
	});

	it("price_cents é NOT NULL com default 0 após a migration", async () => {
		await inRollback(async (tx) => {
			await pre0027(tx);
			await tx.unsafe(MIGRATION);
			const col = one(
				await tx<{ is_nullable: string; column_default: string }[]>`
        SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'appointments' AND column_name = 'price_cents'`,
			);
			expect(col.is_nullable).toBe("NO");
			expect(col.column_default).toBe("0");
		});
	});
});

describe("RF-F01/RF-F02 — 0027 transactions como livro-caixa", () => {
	/** INSERT válido com UMA coluna sobrescrita por um valor inválido. */
	function insertWith(businessId: string, column: string, value: string) {
		const cols: Record<string, string> = {
			business_id: `'${businessId}'`,
			type: "'income'",
			amount_cents: "1000",
			category: "'atendimento'",
			[column]: value,
		};
		return `INSERT INTO transactions (${Object.keys(cols).join(", ")})
            VALUES (${Object.values(cols).join(", ")})`;
	}

	it("aceita recebimento válido com defaults (1 parcela, kind payment)", async () => {
		await inRollback(async (tx) => {
			await pre0027(tx);
			await tx.unsafe(MIGRATION);
			await tx.unsafe(MIGRATION);
			const f = await fixtures(tx);
			const t = one(
				await tx<
					{
						installments: number;
						kind: string;
						voided_at: Date | null;
						created_at: Date;
					}[]
				>`
        INSERT INTO transactions (business_id, type, amount_cents, category, payment_method)
        VALUES (${f.businessId}, 'income', 1000, 'atendimento', 'pix')
        RETURNING installments, kind, voided_at, created_at`,
			);
			expect(t.installments).toBe(1);
			expect(t.kind).toBe("payment");
			expect(t.voided_at).toBeNull();
			expect(t.created_at).toBeInstanceOf(Date);
		});
	});

	it.each([
		["valor zero", "amount_cents", "0"],
		["valor negativo", "amount_cents", "-100"],
		["forma inválida", "payment_method", "'boleto'"],
		["parcelas acima de 12", "installments", "13"],
		["parcelas zero", "installments", "0"],
		["tipo inválido", "kind", "'troco'"],
	])("rejeita %s", async (_label, column, value) => {
		await inRollback(async (tx) => {
			await pre0027(tx);
			await tx.unsafe(MIGRATION);
			const f = await fixtures(tx);
			await expect(
				tx.savepoint((sp) =>
					sp.unsafe(insertWith(f.businessId, column, value)),
				),
			).rejects.toThrow(/violates check constraint/);
		});
	});

	it("cria o índice por agendamento", async () => {
		await inRollback(async (tx) => {
			await pre0027(tx);
			await tx.unsafe(MIGRATION);
			const idx = one(
				await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_indexes
        WHERE indexname = 'transactions_appointment_idx'`,
			);
			expect(idx.n).toBe(1);
		});
	});
});
