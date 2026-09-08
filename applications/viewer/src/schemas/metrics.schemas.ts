import { z } from 'zod';

/**
 * Query schemas for the read endpoints. Also the source the OpenAPI document
 * is generated from, so what the spec advertises is literally what runs.
 */

/**
 * The cap that keeps the in-memory blob scan bounded. An unbounded range is
 * the one input that turns an O(days) scan into a request that never returns,
 * so `from`/`to` are required rather than defaulted - a caller who forgets
 * them gets a 400 naming the field, not a silent full-history scan.
 */
export const MAX_RANGE_DAYS = 31;
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

const isoDate = z.iso.datetime({ offset: true });

const rangeShape = {
  from: isoDate,
  to: isoDate,
};

function refineRange<T extends { from: string; to: string }>(schema: z.ZodType<T>) {
  return schema
    .refine((value) => Date.parse(value.from) <= Date.parse(value.to), {
      path: ['to'],
      message: '`to` must not be earlier than `from`.',
    })
    .refine((value) => Date.parse(value.to) - Date.parse(value.from) <= MAX_RANGE_MS, {
      path: ['to'],
      message: `The range must not exceed ${MAX_RANGE_DAYS} days.`,
    });
}

export const resourcesQuerySchema = refineRange(z.object(rangeShape).strict());

/**
 * `stepSeconds` is the downsampling bucket width. Floored at the collector's
 * own 60s interval - a smaller bucket cannot reveal anything that was never
 * sampled, it only multiplies the points a chart has to draw.
 */
export const metricsQuerySchema = refineRange(
  z
    .object({
      ...rangeShape,
      resource: z.string().min(1).max(200),
      subResource: z.string().min(1).max(200).optional(),
      /**
       * Repeatable. `?name=cpu.usage&name=memory.used` returns both series
       * from ONE blob scan; the client used to issue one request per metric
       * name and each of those re-downloaded every day-blob in the range.
       * Measured against the real deployment: 18 MB per scan pulled from
       * Australia to West Europe, 36 metric names, ~27 s each - a five-minute
       * page. `query parser: 'simple'` gives an array for a repeated key and a
       * string for a single one, so both shapes have to be accepted here.
       */
      name: z
        .union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(100)])
        .transform((value) => (Array.isArray(value) ? value : [value])),
      stepSeconds: z.coerce.number().int().min(60).max(86_400).default(60),
    })
    .strict(),
);

export type ResourcesQuery = z.infer<typeof resourcesQuerySchema>;
export type MetricsQuery = z.infer<typeof metricsQuerySchema>;
