import pg from 'pg';
const client = new pg.Client({ connectionString: "postgres://postgres:***@localhost:5433/minha_agenda_dev" });
await client.connect();
await client.query(`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())`);
const fs = await import('node:fs');
const sql = fs.readFileSync('drizzle/0027_platform_admin.sql','utf8');
const applied = await client.query('SELECT 1 FROM _migrations WHERE name=$1',['0027_platform_admin.sql']);
if (!applied.rowCount) {
  await client.query(sql);
  await client.query('INSERT INTO _migrations (name) VALUES ($1)',['0027_platform_admin.sql']);
  console.log('aplicada');
} else console.log('já aplicada');
await client.end();
