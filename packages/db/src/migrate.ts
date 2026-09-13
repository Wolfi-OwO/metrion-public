import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createPool } from './pool.js';

const defaultMigrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

/**
 * Applies every `.sql` file in `dir`, in filename order, that isn't already
 * recorded in `schema_migrations`. No ORM, no migration framework - a
 * `.sql` file is what a hypertable, a compression policy and a continuous
 * aggregate actually look like, and a table of applied filenames is the
 * whole mechanism a linear, forward-only migration history needs.
 *
 * Returns the names actually applied - empty on a re-run, which is the one
 * behaviour worth asserting on (see tests/migrate.test.ts).
 */
export async function runMigrations(
  pool: Pool,
  dir: string = defaultMigrationsDir,
): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.name));

  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const newlyApplied: string[] = [];
  for (const name of files) {
    if (applied.has(name)) continue;

    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      newlyApplied.push(name);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${name} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}

async function main(): Promise<void> {
  const pool = createPool();
  try {
    for (const name of await runMigrations(pool)) console.log(`applied ${name}`);
  } finally {
    await pool.end();
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
