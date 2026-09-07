import type { Request, Response } from 'express';
import type { MetricsQuery, ResourcesQuery } from '../schemas/metrics.schemas.js';
import { getResources, getSeries } from '../services/metrics-service.js';

/**
 * Read handlers. Both are mounted behind `validateQuery`, so `req.query` is
 * already parsed and range-checked here - a handler that re-checked it would
 * be a second place for the bound to drift out of sync with the schema.
 *
 * `skippedLines` is passed through to the caller rather than swallowed: a day
 * whose blob has unreadable lines should be visible in the response, not only
 * in a log nobody reads.
 */

export async function listResources(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ResourcesQuery;
  const result = await getResources(new Date(query.from), new Date(query.to));
  res.status(200).json(result);
}

export async function getMetricSeries(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as MetricsQuery;
  const result = await getSeries({
    resource: query.resource,
    subResource: query.subResource,
    name: query.name,
    from: new Date(query.from),
    to: new Date(query.to),
    stepSeconds: query.stepSeconds,
  });
  res.status(200).json(result);
}
