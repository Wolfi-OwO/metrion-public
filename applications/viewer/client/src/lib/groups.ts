import type { SeriesResult } from '../api/client.ts';
import { buildGrid, findBlankBands, type Band, type GridRow, type TimeRange } from './range.ts';

/**
 * Turns the loaded series into the charts the page draws: one chart per unit.
 *
 * Grouping by unit is not cosmetic. `percent` and `MiB` on one axis would put
 * a 40% CPU reading and a 4096 MiB memory reading on the same scale, which
 * flattens one of them into the baseline and is simply a wrong chart. The
 * server sends the unit with every series, so the grouping follows the data
 * rather than a list of metric names kept in sync by hand.
 */

/** Eight tokens from `styles/index.css`, all measured at 4.5:1 or better on every surface. */
const SERIES_COLORS = [
  'var(--color-series-1)',
  'var(--color-series-2)',
  'var(--color-series-3)',
  'var(--color-series-4)',
  'var(--color-series-5)',
  'var(--color-series-6)',
  'var(--color-series-7)',
  'var(--color-series-8)',
];

/**
 * The second channel. Colour alone fails for roughly one man in twelve, and a
 * printed or greyscale chart loses it entirely, so every series after the
 * first also carries a stroke pattern. The name is written next to the swatch
 * as well - three channels, and the chart still reads with any one of them.
 */
const SERIES_DASHES = [undefined, '5 3', '2 3', '9 3 2 3', '1 3', '7 3', '4 2 1 2', '12 4'];

export interface SeriesView {
  readonly name: string;
  readonly color: string;
  readonly dash: string | undefined;
  /** Most recent bucket that held a sample, or `null` if the series is empty. */
  readonly last: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly samples: number;
  /** Buckets in range with no sample - the holes drawn as holes. */
  readonly missing: number;
}

export interface ChartGroup {
  readonly unit: string | null;
  readonly series: SeriesView[];
  readonly rows: GridRow[];
  readonly bands: Band[];
  readonly max: number;
}

/**
 * Units in the order an operator asks about them: saturation first (is it
 * healthy), then rates and counts, then absolute sizes, then flags. Anything
 * unknown sorts alphabetically after these - the list is a preference, not a
 * requirement, so a sender using a unit nobody here has seen still gets a
 * chart in a stable position.
 */
const UNIT_ORDER = ['percent', 'count', 'ms', 'bytes/s', 'bytes', 'MiB', 'bool'];

function unitRank(unit: string | null): number {
  if (unit === null) return UNIT_ORDER.length + 1;
  const index = UNIT_ORDER.indexOf(unit);
  return index === -1 ? UNIT_ORDER.length : index;
}

export function groupByUnit(
  results: readonly SeriesResult[],
  range: TimeRange,
  stepSeconds: number,
): ChartGroup[] {
  // A series the range holds no point for comes back with `unit: null` and no
  // points. Charting it would draw an empty axis for a metric that simply does
  // not apply to this sub-resource - `/resources` reports metric names per
  // resource, not per sub-resource, so this is the normal case, not a fault.
  const withData = results.filter((result) => result.points.length > 0);

  const byUnit = new Map<string | null, SeriesResult[]>();
  for (const result of withData) {
    const bucket = byUnit.get(result.unit);
    if (bucket) bucket.push(result);
    else byUnit.set(result.unit, [result]);
  }

  const groups: ChartGroup[] = [];

  for (const [unit, members] of byUnit) {
    const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name));
    const rows = buildGrid(sorted, range, stepSeconds);
    const bands = findBlankBands(rows);

    let max = 0;
    const series = sorted.map((result, index) => {
      const values = result.points.map((point) => point.value);
      const present = rows.filter((row) => row.values[result.name] !== null).length;
      for (const value of values) if (value > max) max = value;

      return {
        name: result.name,
        color: SERIES_COLORS[index % SERIES_COLORS.length] ?? SERIES_COLORS[0]!,
        dash: SERIES_DASHES[index % SERIES_DASHES.length],
        last: values.length > 0 ? (values[values.length - 1] ?? null) : null,
        min: values.length > 0 ? Math.min(...values) : null,
        max: values.length > 0 ? Math.max(...values) : null,
        samples: present,
        missing: rows.length - present,
      };
    });

    groups.push({ unit, series, rows, bands, max });
  }

  return groups.sort(
    (a, b) => unitRank(a.unit) - unitRank(b.unit) || (a.unit ?? '').localeCompare(b.unit ?? ''),
  );
}
