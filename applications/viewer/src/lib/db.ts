import { createPool } from '@metrion/db/dist/pool.js';
import type { Pool } from 'pg';

/**
 * One pool for the process, built lazily on first use.
 *
 * Same shape, and same reasoning, as `applications/ingest/src/lib/db.ts`:
 * `@metrion/db` exports `createPool()`, not a pool instance, so every
 * consumer gets exactly one. Lazy so `GET /api/v1/health/liveness` still
 * needs no connection - only a request that actually reads a row touches
 * this.
 *
 * Called with NO argument, deliberately not `config.databaseUrl`: `config` is
 * a module-level constant, read once at import time, and `createPool()`'s own
 * default parameter reads `process.env['DATABASE_URL']` lazily, at the moment
 * a pool is first built. `tests/metrics.test.ts` (like the ingest service's
 * own test) sets `DATABASE_URL` to an unreachable address BEFORE importing
 * `main.js` - to prove liveness needs no real connection - then swaps it to a
 * real one afterwards. Reading `config.databaseUrl` here would freeze in the
 * unreachable value from import time and never see the swap; `@metrion/db`'s
 * own lazy read does not have that problem. `config.databaseUrl`'s job is
 * only the fail-fast presence check at boot (`config/index.ts`), not
 * supplying the value a pool is actually built with.
 */
let pool: Pool | null = null;

export function getPool(): Pool {
  pool ??= createPool();
  return pool;
}
