import { Router } from 'express';

/**
 * Liveness only: "the process did not wedge", worth a restart if it ever
 * fails. There is no readiness probe: `lib/db.ts`'s pool is built lazily, so
 * importing this route never opens a connection, and Postgres being briefly
 * unreachable is a failed request, not a reason to pull the container out of
 * rotation.
 */
export const healthRouter = Router();

healthRouter.get('/api/v1/health/liveness', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
