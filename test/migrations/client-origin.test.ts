/**
 * 0023/0025 — retroativo da origem do cliente. Roda o SQL real das migrations
 * sobre tabelas TEMPORÁRIAS clients/appointments (pg_temp vem antes de public
 * no search_path), sem tocar nos dados do banco de teste.
 */
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";
// max 1: as tabelas temporárias só existem na mesma conexão
const sql = postgres(DATABASE_URL, { max: 1 });

const migration = (name: string) =>
	fs.readFileSync(path.resolve("drizzle", name), "utf8");
const T0 = "2026-10-01T12:00:00Z";

async function tempTables(withOrigin: boolean) {
	await sql`CREATE TEMP TABLE clients (id text PRIMARY KEY, created_at timestamptz NOT NULL)`;
	if (withOrigin) {
		await sql`ALTER TABLE clients ADD COLUMN origin varchar(20) NOT NULL DEFAULT 'app'`;
	}
	await sql`CREATE TEMP TABLE appointments (client_id text NOT NULL, source text NOT NULL, created_at timestamptz NOT NULL)`;
}

async function origins() {
	const rows = await sql<
		{ id: string; origin: string }[]
	>`SELECT id, origin FROM pg_temp.clients ORDER BY id`;
	return Object.fromEntries(rows.map((r) => [r.id, r.origin]));
}

afterEach(async () => {
	await sql`DROP TABLE IF EXISTS pg_temp.clients, pg_temp.appointments`;
});

afterAll(async () => {
	await sql.end();
});

describe("0023 — retroativo de origin", () => {
	it("só marca public_link quem nasceu junto com o 1º agendamento pelo link", async () => {
		await tempTables(false);
		await sql`
      INSERT INTO clients (id, created_at) VALUES
        ('a-link', ${T0}),
        ('b-manual', ${T0}::timestamptz - interval '1 day'),
        ('c-app-first', ${T0}),
        ('d-sem-agendamento', ${T0})`;
		await sql`
      INSERT INTO appointments (client_id, source, created_at) VALUES
        ('a-link', 'public_link', ${T0}::timestamptz + interval '2 seconds'),
        ('b-manual', 'public_link', ${T0}),
        ('c-app-first', 'app', ${T0}::timestamptz + interval '1 second'),
        ('c-app-first', 'public_link', ${T0}::timestamptz + interval '10 seconds')`;

		const expected = {
			"a-link": "public_link",
			"b-manual": "app",
			"c-app-first": "app",
			"d-sem-agendamento": "app",
		};
		await sql.unsafe(migration("0023_client_origin.sql"));
		expect(await origins()).toEqual(expected);
		await sql.unsafe(migration("0023_client_origin.sql"));
		expect(await origins()).toEqual(expected);
	});
});

describe("0025 — desfaz o retroativo antigo", () => {
	it("volta para app quem foi marcado só pela origem do 1º agendamento", async () => {
		await tempTables(true);
		await sql`
      INSERT INTO clients (id, created_at, origin) VALUES
        ('a-marcado-errado', ${T0}::timestamptz - interval '1 day', 'public_link'),
        ('b-link', ${T0}, 'public_link'),
        ('c-link-sem-agendamento', ${T0}, 'public_link'),
        ('d-app', ${T0}, 'app')`;
		await sql`
      INSERT INTO appointments (client_id, source, created_at) VALUES
        ('a-marcado-errado', 'public_link', ${T0}),
        ('b-link', 'public_link', ${T0}::timestamptz + interval '2 seconds'),
        ('d-app', 'public_link', ${T0}::timestamptz + interval '2 seconds')`;

		const expected = {
			"a-marcado-errado": "app",
			"b-link": "public_link",
			"c-link-sem-agendamento": "public_link",
			"d-app": "app",
		};
		await sql.unsafe(migration("0025_client_origin_fix.sql"));
		expect(await origins()).toEqual(expected);
		await sql.unsafe(migration("0025_client_origin_fix.sql"));
		expect(await origins()).toEqual(expected);
	});
});
