import type { Request, Response } from 'express';
import type { MetricEnvelope } from '@mona/shared';
import { appendEnvelopes } from '../lib/blob-writer.js';
import type { IngestBody } from '../schemas/ingest.schemas.js';

/**
 * Accepts one envelope or an array of them and appends them as one line.
 *
 * `req.body` is whatever `validateBody` produced, which is the zod-parsed
 * value with unknown keys already stripped - the handler does no re-checking,
 * because a second check is a second place for the rules to drift.
 *
 * 202, not 201: the line is durably appended, but nothing is created at a URL
 * the caller can then fetch, and a read of it is only meaningful once a query
 * range covers its timestamps.
 */
export async function ingestMetrics(req: Request, res: Response): Promise<void> {
  const body = req.body as IngestBody;
  const envelopes: MetricEnvelope[] = Array.isArray(body) ? body : [body];

  await appendEnvelopes(envelopes);

  res.status(202).json({
    accepted: envelopes.length,
    points: envelopes.reduce((total, envelope) => total + envelope.metrics.length, 0),
  });
}
