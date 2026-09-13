import type { Request, Response } from 'express';
import type { MetricEnvelope, MetricPoint } from '@metrion/shared';
import { getPool } from '../lib/db.js';
import { BadRequestError } from '../middlewares/error.js';
import type { IngestBody } from '../schemas/ingest.schemas.js';

function isBareMetricPoints(body: IngestBody): body is MetricPoint[] {
  return Array.isArray(body) && body.length > 0 && !('metrics' in (body[0] as object));
}

/**
 * Normalizes all three accepted body shapes (`schemas/ingest.schemas.ts`)
 * into envelopes. `resource` on a bare metric-point array falls back to the
 * project's `default_resource` - never anything read from the body, per
 * ADR 0005: the only thing a caller's key ever decides is `project_id`, and
 * `resource` stays a plain label even on the branch that has to invent one.
 */
function toEnvelopes(body: IngestBody, defaultResource: string | null): MetricEnvelope[] {
  if (isBareMetricPoints(body)) {
    if (!defaultResource) {
      throw new BadRequestError(
        'This project has no default_resource configured; a bare metric-point array needs one to fall back to. Send an enveloped body with an explicit "resource" instead.',
      );
    }
    return [{ resource: defaultResource, metrics: body }];
  }
  return Array.isArray(body) ? body : [body];
}

interface MetricRow {
  readonly time: string;
  readonly resource: string;
  readonly subResource: string | null;
  readonly name: string;
  readonly value: number;
  readonly unit: string;
  readonly intervalSeconds: number;
}

function toRows(envelopes: readonly MetricEnvelope[]): MetricRow[] {
  return envelopes.flatMap((envelope) =>
    envelope.metrics.map((point) => ({
      time: point.timestamp,
      resource: envelope.resource,
      subResource: envelope.subResource ?? null,
      name: point.name,
      value: point.value,
      unit: point.unit,
      intervalSeconds: point.intervalSeconds,
    })),
  );
}

const COLUMNS_PER_ROW = 8;

/**
 * One parameterised multi-row `INSERT` per request. `projectId` is resolved
 * exactly once, by `requireApiKey`, from the authenticated key - it is the
 * only project a row from this request can ever land in, regardless of what
 * `resource` string the body names (ADR 0005: a `resource` value that
 * happens to match another project's own naming still writes here, under
 * this key's project).
 */
async function insertRows(projectId: string, rows: readonly MetricRow[]): Promise<void> {
  if (rows.length === 0) return;

  const values: unknown[] = [];
  const placeholders = rows.map((row, index) => {
    const base = index * COLUMNS_PER_ROW;
    values.push(
      row.time,
      projectId,
      row.resource,
      row.subResource,
      row.name,
      row.value,
      row.unit,
      row.intervalSeconds,
    );
    const params = Array.from({ length: COLUMNS_PER_ROW }, (_, i) => `$${base + i + 1}`);
    return `(${params.join(', ')})`;
  });

  await getPool().query(
    `INSERT INTO metrics (time, project_id, resource, sub_resource, name, value, unit, interval_seconds)
     VALUES ${placeholders.join(', ')}`,
    values,
  );
}

/**
 * 202, not 201: the rows are durably written, but nothing is created at a URL
 * the caller can then fetch - same reasoning the viewer's blob-backed ingest
 * endpoint used before this replaced it.
 */
export async function ingestMetrics(req: Request, res: Response): Promise<void> {
  const auth = req.apiKeyContext;
  if (!auth) {
    // requireApiKey is mounted ahead of this handler on every route that
    // reaches it; reaching here without it is a wiring bug, not a client error.
    throw new Error('ingestMetrics reached with no apiKeyContext - requireApiKey did not run.');
  }

  const body = req.body as IngestBody;
  const envelopes = toEnvelopes(body, auth.defaultResource);
  const rows = toRows(envelopes);

  await insertRows(auth.projectId, rows);

  res.status(202).json({
    accepted: envelopes.length,
    points: rows.length,
  });
}
