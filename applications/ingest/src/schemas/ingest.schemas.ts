import { z } from 'zod';

/**
 * The single source of truth for what `POST /api/v1/ingest` accepts. Enforced
 * at runtime by `middlewares/validate.ts` and converted into the OpenAPI
 * request body by `docs/openapi.ts`, so the published spec cannot drift from
 * what the endpoint actually takes.
 *
 * `IDENTIFIER`, the clock-skew bounds and the per-request caps below are
 * copied from `applications/viewer/src/schemas/ingest.schemas.ts` unchanged -
 * they were already correct there and this endpoint accepts the same wire
 * format, just authenticated differently (see ADR 0005).
 */

/**
 * `resource` and `subResource` are identity keys: they group series in the
 * `metrics_series_idx` index (`packages/db/migrations/0003_metrics_hypertable.sql`).
 * Restricting the charset means a stored value can never become a path
 * traversal or worse. `:` and `.` are allowed because real senders already
 * write things like `container:portfolio-caddy-1`.
 */
const IDENTIFIER = /^[A-Za-z0-9._:-]+$/;

const identifier = z.string().min(1).max(200).regex(IDENTIFIER, {
  message: 'Only letters, digits, dot, underscore, colon and hyphen are allowed.',
});

/** Newest a timestamp may be: a little clock skew ahead of this server is normal. */
const MAX_FUTURE_MS = 5 * 60 * 1000;
/** Oldest a timestamp may be - anything older is rejected rather than silently accepted. */
const MAX_PAST_MS = 24 * 60 * 60 * 1000;

/** Hard cap per envelope/bare array. Generous above any real sender's busiest minute. */
const MAX_POINTS_PER_ENVELOPE = 1000;
/** Hard cap per request, so one call cannot append an unbounded number of rows. */
const MAX_ENVELOPES_PER_REQUEST = 200;

const metricPointShape = z.object({
  name: identifier.describe('Dotted metric name, e.g. "cpu.usage".'),
  value: z.number().finite(),
  unit: z.string().min(1).max(32).describe('e.g. "percent", "MiB", "bytes/s", "count", "ms".'),
  intervalSeconds: z.number().int().positive().max(86_400),
  timestamp: z.iso
    .datetime({ offset: true })
    .refine(
      (value) => {
        const at = Date.parse(value);
        const now = Date.now();
        return at <= now + MAX_FUTURE_MS && at >= now - MAX_PAST_MS;
      },
      { message: 'The timestamp must be within the last 24 hours and not in the future.' },
    )
    .describe('ISO-8601 UTC.'),
});

/**
 * `interval` is accepted as a plain alias for `intervalSeconds` - the exact
 * field name the bare metric-point shape was originally specified with.
 * Renamed before the object schema ever sees it, so every branch downstream
 * of this preprocess only ever has to know one field name.
 */
export const metricPointSchema = z.preprocess((raw) => {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (obj['intervalSeconds'] === undefined && obj['interval'] !== undefined) {
      const { interval, ...rest } = obj;
      return { ...rest, intervalSeconds: interval };
    }
  }
  return raw;
}, metricPointShape);

export const metricEnvelopeSchema = z.object({
  resource: identifier.describe('The sender, e.g. "vps-contabo-01".'),
  subResource: identifier.optional().describe('e.g. "container:portfolio-caddy-1".'),
  metrics: z.array(metricPointSchema).min(1).max(MAX_POINTS_PER_ENVELOPE),
});

/**
 * Three accepted body shapes: one envelope, an array of envelopes, or a bare
 * array of metric points with no `resource` wrapper at all - the shape a
 * sender with no SDK writes most naturally. `resource` for that third branch
 * is resolved in the handler from the authenticated project's
 * `default_resource` (`projects.default_resource`) - never from the body,
 * per ADR 0005. There is deliberately no `resource` field anywhere on this
 * branch for a body to fill in.
 *
 * Plain `z.object` (not `.strict()`) on the envelope shapes: unknown keys are
 * STRIPPED rather than rejected, so a sender running a newer client that adds
 * a field keeps working, and the stripped value never reaches the handler or
 * the database.
 */
export const ingestBodySchema = z.union([
  metricEnvelopeSchema,
  z.array(metricEnvelopeSchema).min(1).max(MAX_ENVELOPES_PER_REQUEST),
  z.array(metricPointSchema).min(1).max(MAX_POINTS_PER_ENVELOPE),
]);

export type IngestBody = z.infer<typeof ingestBodySchema>;
