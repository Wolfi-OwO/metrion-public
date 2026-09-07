/**
 * Time ranges, downsampling steps, and the bucket grid the charts draw on.
 *
 * All of it is pure and lives here rather than in a component because it is
 * the part that can be wrong in a way nobody sees: an off-by-one bucket does
 * not throw, it silently redraws the data. `tests/range.test.ts` covers it.
 */

/**
 * `applications/viewer/src/schemas/metrics.schemas.ts` rejects any range wider
 * than 31 days with a 400. Duplicated as a hard clamp rather than trusted,
 * because a UI that can construct an illegal request has a bug the user sees
 * as "the app is broken".
 */
export const MAX_RANGE_DAYS = 31;
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

export interface RangePreset {
  readonly id: string;
  /** What the button says. */
  readonly label: string;
  /** Read out to screen readers, where "6h" is ambiguous. */
  readonly description: string;
  readonly spanMs: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Presets only, deliberately. Every one of them is inside the API's 31-day cap
 * by construction, so the range control cannot produce a request the server
 * refuses - the failure mode a free date pair would introduce. The top preset
 * is 30 days rather than the full 31 so the cap is never approached from the
 * wrong side by clock skew between this browser and the server.
 *
 * ponytail: no custom from/to picker. Add one when a preset genuinely cannot
 * answer a question - and route it through `clampRange` below, which already
 * enforces the cap.
 */
export const RANGE_PRESETS: readonly RangePreset[] = [
  { id: '1h', label: '1h', description: 'Last hour', spanMs: HOUR },
  { id: '6h', label: '6h', description: 'Last 6 hours', spanMs: 6 * HOUR },
  { id: '24h', label: '24h', description: 'Last 24 hours', spanMs: DAY },
  { id: '7d', label: '7d', description: 'Last 7 days', spanMs: 7 * DAY },
  { id: '30d', label: '30d', description: 'Last 30 days', spanMs: 30 * DAY },
];

export interface TimeRange {
  readonly from: Date;
  readonly to: Date;
}

/** Never wider than the API allows, never inverted. */
export function clampRange(from: Date, to: Date): TimeRange {
  const end = Math.max(from.getTime(), to.getTime());
  const start = Math.max(Math.min(from.getTime(), to.getTime()), end - MAX_RANGE_MS);
  return { from: new Date(start), to: new Date(end) };
}

export function rangeFor(preset: RangePreset, now: Date): TimeRange {
  return clampRange(new Date(now.getTime() - preset.spanMs), now);
}

/**
 * Bucket widths the server accepts (>= its own 60s sampling interval) and a
 * human reads off an axis without arithmetic: minutes, quarter hours, hours,
 * quarter days, days.
 */
const STEP_LADDER_SECONDS = [60, 300, 900, 3600, 10_800, 21_600, 43_200, 86_400];

/**
 * How many points a chart is allowed to carry. Past roughly this many, an SVG
 * polyline is drawing several points per screen pixel - more work, no more
 * information, and a slower response from a backend that scans blobs.
 */
const TARGET_POINTS = 600;

/** The coarsest step is a deliberate floor: at 30 days it yields 720 points. */
export function chooseStepSeconds(range: TimeRange): number {
  const spanSeconds = (range.to.getTime() - range.from.getTime()) / 1000;
  const wanted = spanSeconds / TARGET_POINTS;
  return STEP_LADDER_SECONDS.find((step) => step >= wanted) ?? 86_400;
}

export interface GridRow {
  /** Bucket start, epoch milliseconds - a number so the x axis can be linear. */
  readonly t: number;
  /** Metric name to bucket mean, or `null` where that bucket has no sample. */
  readonly values: Record<string, number | null>;
}

interface SeriesInput {
  readonly name: string;
  readonly points: readonly { readonly timestamp: string; readonly value: number }[];
}

/**
 * Lays every series onto one shared bucket grid.
 *
 * This is where gaps become visible. The API returns only the buckets that
 * held a sample, so a series that stopped for six hours simply skips six hours
 * of timestamps - and a chart handed those points draws a straight line across
 * the hole, inventing data that was never collected. Worse, the collector
 * deliberately emits NO point for a null network rate rather than a zero, so
 * these holes are a designed part of the data, not a rare fault.
 *
 * Every bucket in the range therefore gets a row, and a bucket with no sample
 * gets `null` - which recharts renders as a break, because `connectNulls` is
 * off. Buckets are floored against the epoch, exactly as `getSeries` does
 * server-side, so a row here lines up with the bucket it came from.
 */
export function buildGrid(
  series: readonly SeriesInput[],
  range: TimeRange,
  stepSeconds: number,
): GridRow[] {
  const stepMs = stepSeconds * 1000;
  const first = Math.floor(range.from.getTime() / stepMs) * stepMs;
  const last = Math.floor(range.to.getTime() / stepMs) * stepMs;

  const byBucket = new Map<number, Record<string, number>>();
  for (const one of series) {
    for (const point of one.points) {
      const at = Date.parse(point.timestamp);
      if (!Number.isFinite(at)) continue;
      const bucket = Math.floor(at / stepMs) * stepMs;
      let row = byBucket.get(bucket);
      if (!row) {
        row = {};
        byBucket.set(bucket, row);
      }
      row[one.name] = point.value;
    }
  }

  const rows: GridRow[] = [];
  for (let t = first; t <= last; t += stepMs) {
    const found = byBucket.get(t);
    const values: Record<string, number | null> = {};
    for (const one of series) values[one.name] = found?.[one.name] ?? null;
    rows.push({ t, values });
  }
  return rows;
}

export interface Band {
  readonly from: number;
  readonly to: number;
}

/**
 * Stretches where not one series produced a sample - the machine was off, or
 * the collector was not running.
 *
 * Only runs of three or more empty buckets become a band. A single dropped
 * sample is already legible as a break in the line, and shading it would turn
 * an ordinary minute into a striped alarm.
 */
export function findBlankBands(rows: readonly GridRow[], minBuckets = 3): Band[] {
  const bands: Band[] = [];
  let runStart: number | null = null;
  let runLength = 0;

  const close = (endIndex: number) => {
    if (runStart !== null && runLength >= minBuckets) {
      const end = rows[endIndex - 1];
      if (end) bands.push({ from: runStart, to: end.t });
    }
    runStart = null;
    runLength = 0;
  };

  rows.forEach((row, index) => {
    const empty = Object.values(row.values).every((value) => value === null);
    if (empty) {
      if (runStart === null) runStart = row.t;
      runLength += 1;
    } else {
      close(index);
    }
  });
  close(rows.length);

  return bands;
}
