// Aplica migrations SQL pendentes no Supabase direto via pg.Client
// (drizzle-kit migrate falha no pooler — padrão estabelecido 09/09).
// Uso: set -a && source .env && set +a && node scripts/run-migrations.mjs
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

await client.query(
  `CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())`,
);

const dir = path.resolve('drizzle');
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

for (const f of files) {
  const applied = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [f]);
  if (applied.rowCount > 0) {
    console.log(`= ${f} (já aplicada)`);
    continue;
  }
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  try {
    await client.query(sql);
    await client.query('INSERT INTO _migrations (name) VALUES ($1)', [f]);
    console.log(`+ ${f} aplicada`);
  } catch (e) {
    console.error(`! ${f} FALHOU: ${e.message}`);
    process.exitCode = 1;
    break;
  }
}

await client.end();
