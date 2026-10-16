// Minimal forward-only SQL migration runner.
//   node db/migrate.mjs            apply pending migrations (uses DATABASE_MIGRATE_URL, the owner role)
//   node db/migrate.mjs --status   list applied / pending
//   node db/migrate.mjs --check    health check using DATABASE_URL (the least-privilege app role)
// Files in db/migrations/NNNN_name.sql run in order, each in its own transaction. Applied files are
// recorded with a SHA-256 checksum; editing an applied file is an error (write a new migration).
// Credentials come only from the environment (or a file named in DB_ENV_FILE); nothing is printed.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'migrations');

if (process.env.DB_ENV_FILE) {
  for (const line of readFileSync(process.env.DB_ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

function connect(varName) {
  const url = process.env[varName];
  if (!url) throw new Error(`${varName} is not set`);
  return new pg.Client({ connectionString: url, application_name: 'sugarsense-db-tool' });
}

const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
const arg = process.argv[2];

if (arg === '--check') {
  const c = connect('DATABASE_URL');
  await c.connect();
  const r = await c.query('select current_user as who, current_database() as db, now() as server_time');
  console.log(`db health ok: user=${r.rows[0].who} db=${r.rows[0].db}`);
  await c.end();
} else {
  const c = connect('DATABASE_MIGRATE_URL');
  await c.connect();
  try {
    await c.query('select pg_advisory_lock(727001)');
    await c.query(`create table if not exists schema_migrations (
      version text primary key, checksum text not null, applied_at timestamptz not null default now())`);
    const applied = new Map(
      (await c.query('select version, checksum from schema_migrations')).rows.map((r) => [r.version, r.checksum]),
    );
    for (const f of files) {
      const sql = readFileSync(join(dir, f), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      const done = applied.get(f);
      if (done !== undefined) {
        if (done !== sum) throw new Error(`${f} was edited after it was applied (checksum mismatch)`);
        if (arg === '--status') console.log(`applied  ${f}`);
        continue;
      }
      if (arg === '--status') {
        console.log(`pending  ${f}`);
        continue;
      }
      await c.query('begin');
      try {
        await c.query(sql);
        await c.query('insert into schema_migrations (version, checksum) values ($1, $2)', [f, sum]);
        await c.query('commit');
        console.log(`applied  ${f}`);
      } catch (e) {
        await c.query('rollback');
        throw new Error(`${f} failed and was rolled back: ${e.message}`);
      }
    }
  } finally {
    await c.query('select pg_advisory_unlock(727001)').catch(() => {});
    await c.end();
  }
}
