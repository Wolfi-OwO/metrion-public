import { z } from 'zod';

/**
 * The single source of truth for what `POST /api/v1/ingest` accepts. Enforced
 * at runtime by `middlewares/validate.ts` and converted into the OpenAPI
 * request body by `docs/openapi.ts`, so the published spec cannot drift from
 * what the endpoint actually takes.
 */

/**
 * `resource` and `subResource` are identity keys: they group series, and the
 * hourly-rollup upgrade path named in `metrics-service.ts` would put them in a
 * blob name. Restricting the charset now means that later change cannot turn a
 * stored value into a path traversal or a blob name the API can no longer
 * address. `:` and `.` are allowed because the collector already writes
 * `container:portfolio-caddy-1` and `requests:woofi-developments.at`.
 */
const IDENTIFIER = /^[A-Za-z0-9._:-]+$/;

const identifier = z.string().min(1).max(200).regex(IDENTIFIER, {
  message: 'Only letters, digits, dot, underscore, colon and hyphen are allowed.',
});

/** Newest a timestamp may be: a little clock skew ahead of this server is normal. */
const MAX_FUTURE_MS = 5 * 60 * 1000;
/** Oldest a timestamp may be. See `ingest.handlers.ts` for why this is bounded at all. */
const MAX_PAST_MS = 24 * 60 * 60 * 1000;

/** Hard cap per envelope. The collector's own busiest minute is ~20 points. */
const MAX_POINTS_PER_ENVELOPE = 1000;
/** Hard cap per request, so one call cannot append an unbounded line. */
const MAX_ENVELOPES_PER_REQUEST = 200;

export const metricPointSchema = z.object({
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

export const metricEnvelopeSchema = z.object({
  resource: identifier.describe('The sender, e.g. "vps-contabo-01".'),
  subResource: identifier.optional().describe('e.g. "container:portfolio-caddy-1".'),
  metrics: z.array(metricPointSchema).min(1).max(MAX_POINTS_PER_ENVELOPE),
});

/**
 * One envelope or an array of them. Plain `z.object` (not `.strict()`) on
 * purpose: unknown keys are STRIPPED rather than rejected, so a sender running
 * a newer client that adds a field keeps working, and the stripped value never
 * reaches the handler or the blob.
 */
export const ingestBodySchema = z.union([
  metricEnvelopeSchema,
  z.array(metricEnvelopeSchema).min(1).max(MAX_ENVELOPES_PER_REQUEST),
]);

export type IngestBody = z.infer<typeof ingestBodySchema>;
