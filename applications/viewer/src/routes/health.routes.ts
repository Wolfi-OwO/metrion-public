import { Router } from 'express';

/**
 * Liveness only: "the process did not wedge", worth a restart if it ever
 * fails. There is no readiness probe because there is nothing to be ready
 * for - the viewer holds no connection pool, and Azure Blob being briefly
 * unreachable is a 503 on one request, not a reason to pull the container
 * out of rotation.
 */
export const healthRouter = Router();

healthRouter.get('/api/v1/health/liveness', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
