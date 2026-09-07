import { Router } from 'express';
import { getMetricSeries, listResources } from '../handlers/metrics.handlers.js';
import { asyncHandler } from '../middlewares/error.js';
import { validateQuery } from '../middlewares/validate.js';
import { metricsQuerySchema, resourcesQuerySchema } from '../schemas/metrics.schemas.js';

/**
 * The read API. Public on purpose: this is aggregate resource usage of the
 * user's own machines - no personal data, and nothing per-request beyond a
 * hostname count. Only `/api/v1/ingest` (a write path) is authenticated.
 */
export const metricsRouter = Router();

metricsRouter.get(
  '/api/v1/resources',
  validateQuery(resourcesQuerySchema),
  asyncHandler(listResources),
);

metricsRouter.get(
  '/api/v1/metrics',
  validateQuery(metricsQuerySchema),
  asyncHandler(getMetricSeries),
);
