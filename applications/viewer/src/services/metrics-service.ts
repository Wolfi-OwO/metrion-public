import type { MetricEnvelope, MetricPoint } from '@mona/shared';
import { readDayBlobLines, utcDaysBetween } from '../lib/blob-reader.js';
import { parseLines } from '../lib/legacy-adapter.js';

/**
 * Aggregates the day-blobs in memory. There is no database on purpose: the
 * blobs already hold every number, so a query engine would be new
 * infrastructure and new cost for data that already fits in RAM.
 *
 * ponytail: this scans and parses every line of every day-blob in the
 * requested range on every request - O(days x 1440 lines). The 31-day cap in
 * `schemas/metrics.schemas.ts` is what keeps that bounded, and ADR 0001's
 * `vps-metrics-retention-90d` lifecycle policy caps the absolute worst case at
 * roughly 90 blobs. Upgrade path for when a month-long range stops feeling
 * instant: write pre-aggregated hourly rollup blobs alongside the raw days and
 * serve long ranges from those. The rollup is a file - do not reach for a
 * database first.
 */

/**
 * Visits every envelope in the range, one day-blob at a time, and returns the
 * number of unreadable lines skipped.
 *
 * One day at a time on purpose, and measured before it was written that way.
 * The previous shape fetched all the days with `Promise.all` and collected
 * every envelope into one array before the caller saw any of them. Against a
 * realistic day-blob (9,281 bytes per line, 1440 lines = 13.4 MB/day) a
 * 31-day range held 414 MB of raw buffers plus 624 MB of parsed envelopes at
 * once - 782 MB RSS for a SINGLE request, on an endpoint that needs no
 * credentials, against a container app that runs one replica. That is an
 * out-of-memory kill anyone could trigger with one curl. Folding each day into
 * the caller's accumulator and dropping it before fetching the next caps the
 * peak at one day's worth regardless of how wide the range is.
 *
 * ponytail: sequential, so a 31-day range costs 31 round trips instead of one
 * fan-out - slower, bounded. Upgrade path when that latency starts to matter:
 * the pre-aggregated hourly rollup blobs described in the file header, NOT a
 * wider fan-out. The fan-out is what ran the process out of memory.
 */
async function forEachEnvelope(
  from: Date,
  to: Date,
  visit: (envelope: MetricEnvelope) => void,
): Promise<number> {
  let skippedLines = 0;

  for (const day of utcDaysBetween(from, to)) {
    const parsed = parseLines(await readDayBlobLines(day));
    skippedLines += parsed.skipped;
    for (const envelope of parsed.envelopes) visit(envelope);
  }

  return skippedLines;
}

function withinRange(point: MetricPoint, from: Date, to: Date): boolean {
  const at = Date.parse(point.timestamp);
  return Number.isFinite(at) && at >= from.getTime() && at <= to.getTime();
}

export interface ResourceSummary {
  readonly resource: string;
  readonly subResources: string[];
  readonly metricNames: string[];
}

/**
 * Distinct `resource`, `subResource` and metric names seen in the range - what
 * a chart needs to offer a picker without downloading any series first.
 */
export async function getResources(
  from: Date,
  to: Date,
): Promise<{ resources: ResourceSummary[]; skippedLines: number }> {
  const byResource = new Map<string, { subResources: Set<string>; metricNames: Set<string> }>();

  const skippedLines = await forEachEnvelope(from, to, (envelope) => {
    const pointsInRange = envelope.metrics.filter((point) => withinRange(point, from, to));
    if (pointsInRange.length === 0) return;

    let entry = byResource.get(envelope.resource);
    if (!entry) {
      entry = { subResources: new Set<string>(), metricNames: new Set<string>() };
      byResource.set(envelope.resource, entry);
    }
    if (envelope.subResource !== undefined) entry.subResources.add(envelope.subResource);
    for (const point of pointsInRange) entry.metricNames.add(point.name);
  });

  const resources = [...byResource.entries()]
    .map(([resource, entry]) => ({
      resource,
      subResources: [...entry.subResources].sort(),
      metricNames: [...entry.metricNames].sort(),
    }))
    .sort((a, b) => a.resource.localeCompare(b.resource));

  return { resources, skippedLines };
}

export interface SeriesBatchQuery {
  readonly resource: string;
  readonly subResource?: string | undefined;
  /** One blob scan serves all of these. See `metrics.schemas.ts` for why. */
  readonly names: readonly string[];
  readonly from: Date;
  readonly to: Date;
  readonly stepSeconds: number;
}

export interface SeriesPoint {
  /** Start of the bucket, ISO-8601 UTC. */
  readonly timestamp: string;
  /** Mean of the raw points in the bucket. */
  readonly value: number;
  /** How many raw points the mean is over - an honest 1 beats a smooth-looking lie. */
  readonly count: number;
}

export interface SeriesResult {
  readonly resource: string;
  readonly subResource?: string | undefined;
  readonly name: string;
  readonly unit: string | null;
  readonly stepSeconds: number;
  readonly points: SeriesPoint[];
}

export interface SeriesBatch {
  readonly series: SeriesResult[];
  readonly skippedLines: number;
}

/**
 * One downsampled series. Buckets are aligned to the epoch rather than to
 * `from`, so two requests with different start times over the same window
 * return the same bucket boundaries and a chart does not shimmer when its
 * range slides by a few seconds.
 */
export async function getSeries(query: SeriesBatchQuery): Promise<SeriesBatch> {
  const stepMs = query.stepSeconds * 1000;

  // One pass over the range for ALL requested names. The endpoint used to take
  // a single name, so drawing one page meant one full scan per metric - and a
  // scan is an 18 MB cross-region download, not a cheap loop. Measured against
  // the real deployment: 36 names x ~27 s = a five-minute page, of which 36.4 s
  // per scan was the Australia-to-Europe transfer and 98 ms was the parsing.
  //
  // Accumulating into per-name buckets keeps the streaming shape
  // `forEachEnvelope` exists for: still one day-blob resident at a time, so a
  // wide range cannot be turned into an out-of-memory kill.
  const wanted = new Set(query.names);
  const buckets = new Map<string, Map<number, { sum: number; count: number }>>();
  const units = new Map<string, string>();

  const skippedLines = await forEachEnvelope(query.from, query.to, (envelope) => {
    if (envelope.resource !== query.resource) return;
    if ((envelope.subResource ?? undefined) !== query.subResource) return;

    for (const point of envelope.metrics) {
      if (!wanted.has(point.name)) continue;
      if (!withinRange(point, query.from, query.to)) continue;
      if (!Number.isFinite(point.value)) continue;

      if (!units.has(point.name)) units.set(point.name, point.unit);

      let byBucket = buckets.get(point.name);
      if (!byBucket) {
        byBucket = new Map();
        buckets.set(point.name, byBucket);
      }

      const bucketStart = Math.floor(Date.parse(point.timestamp) / stepMs) * stepMs;
      const bucket = byBucket.get(bucketStart);
      if (bucket) {
        bucket.sum += point.value;
        bucket.count += 1;
      } else {
        byBucket.set(bucketStart, { sum: point.value, count: 1 });
      }
    }
  });

  // Every requested name comes back even with no points, so a caller can tell
  // "nothing in this window" apart from "that metric does not exist".
  const series = query.names.map((name) => ({
    resource: query.resource,
    subResource: query.subResource,
    name,
    unit: units.get(name) ?? null,
    stepSeconds: query.stepSeconds,
    points: [...(buckets.get(name) ?? new Map<number, { sum: number; count: number }>()).entries()]
      .sort(([a], [b]) => a - b)
      .map(([bucketStart, bucket]) => ({
        timestamp: new Date(bucketStart).toISOString(),
        value: bucket.sum / bucket.count,
        count: bucket.count,
      })),
  }));

  return { series, skippedLines };
}
