import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runMigrations } from '../dist/migrate.js';
import { createPool } from '../dist/pool.js';

/**
 * Runs against a real Postgres - `createPool()`'s local-dev default, which
 * matches `docker-compose.dev.yml` - not a mock connection. A migration
 * runner's only interesting behaviour is "applies each file once, then
 * applies nothing," and that is not something a mock can prove; it needs a
 * real `schema_migrations` table to actually be written to and read back.
 * Requires `docker compose -f docker-compose.dev.yml up -d` beforehand.
 */
test('runMigrations: applies each file once, in filename order, then applies nothing on re-run', async () => {
  const pool = createPool();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrion-db-migrate-test-'));
  const marker = `migrate_test_${Date.now()}`;

  fs.writeFileSync(
    path.join(dir, '0001_create.sql'),
    `CREATE TABLE ${marker} (id integer PRIMARY KEY);`,
  );
  fs.writeFileSync(path.join(dir, '0002_alter.sql'), `ALTER TABLE ${marker} ADD COLUMN note text;`);

  try {
    const firstRun = await runMigrations(pool, dir);
    assert.deepEqual(firstRun, ['0001_create.sql', '0002_alter.sql']);

    const secondRun = await runMigrations(pool, dir);
    assert.deepEqual(secondRun, []);

    const { rows } = await pool.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name',
      [marker],
    );
    assert.deepEqual(
      rows.map((row) => row.column_name),
      ['id', 'note'],
    );
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${marker}`);
    await pool.query('DELETE FROM schema_migrations WHERE name IN ($1, $2)', [
      '0001_create.sql',
      '0002_alter.sql',
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
});
