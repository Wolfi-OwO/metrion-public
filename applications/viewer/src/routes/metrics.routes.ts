import { Router } from 'express';
import { getMetricSeries, listResources } from '../handlers/metrics.handlers.js';
import { asyncHandler } from '../middlewares/error.js';
import { resolveProjectIds } from '../middlewares/project-scope.js';
import { validateQuery } from '../middlewares/validate.js';
import { metricsQuerySchema, resourcesQuerySchema } from '../schemas/metrics.schemas.js';

/**
 * The read API. No token required at the HTTP layer - there is no session
 * system yet (issue #7, Task 6) - but every response is scoped to
 * `req.projectIds`, set by `resolveProjectIds` ahead of both routes, so a
 * request answers for at most the projects that middleware names, never for
 * everything in the database. Only `/api/v1/ingest` (a write path, a
 * separate service) is authenticated today.
 */
export const metricsRouter = Router();

metricsRouter.get(
  '/api/v1/resources',
  resolveProjectIds,
  validateQuery(resourcesQuerySchema),
  asyncHandler(listResources),
);

metricsRouter.get(
  '/api/v1/metrics',
  resolveProjectIds,
  validateQuery(metricsQuerySchema),
  asyncHandler(getMetricSeries),
);
