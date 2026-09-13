import { Pool } from 'pg';

// Matches the `db` service credentials in docker-compose.dev.yml exactly -
// the fallback for local dev only, so `npm run migrate` works against a
// freshly `docker compose up`'d container with no separate .env step.
// Production always sets a real DATABASE_URL.
const LOCAL_DEV_DATABASE_URL = 'postgres://metrion:metrion@localhost:5432/metrion';

/**
 * One pool for the process. `pg.Pool` already does connection reuse and
 * queueing - wrapping it in anything more is the "config for a value that
 * never changes" ladder rung. Everything else (pool size, timeouts) is a
 * `pg` default until a real workload proves a default wrong.
 */
export function createPool(
  connectionString = process.env['DATABASE_URL'] ?? LOCAL_DEV_DATABASE_URL,
): Pool {
  return new Pool({ connectionString });
}
