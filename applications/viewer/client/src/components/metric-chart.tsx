import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import type { ChartGroup, SeriesView } from '../lib/groups.ts';
import {
  axisDomain,
  axisTicks,
  formatAxisValue,
  formatTick,
  formatTimestamp,
  formatValue,
} from '../lib/format.ts';
import type { GridRow, TimeRange } from '../lib/range.ts';

/**
 * One unit, one chart, drawn as a strip on a time axis shared with every other
 * chart on the page rather than as a card in a grid.
 *
 * The shared axis is the whole point: the question this tool answers is "what
 * else was happening when CPU spiked", and that is a question about one
 * instant read across several measurements. Cards with their own axes make
 * that a manual alignment job. `syncId` extends the same idea to the cursor -
 * hovering any strip moves the crosshair on all of them.
 */

const STROKE_WIDTH = 1.5;

function SeriesSwatch({ series }: { series: SeriesView }) {
  return (
    <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden="true" className="shrink-0">
      <line
        x1="0"
        y1="4"
        x2="16"
        y2="4"
        stroke={series.color}
        strokeWidth="2"
        strokeDasharray={series.dash}
      />
    </svg>
  );
}

function ChartTooltip({
  active,
  label,
  payload,
  unit,
}: TooltipContentProps & { unit: string | null }) {
  if (!active || payload.length === 0) return null;

  return (
    <div className="border border-line-strong bg-bg-900 px-2.5 py-2 text-[11px] shadow-none">
      <div className="mb-1 font-mono text-ink-dim">
        {typeof label === 'number' ? formatTimestamp(label) : ''}
      </div>
      {payload.map((entry) => (
        <div key={String(entry.name)} className="flex items-baseline gap-2">
          <span className="font-mono text-ink-dim">{entry.name}</span>
          <span className="ml-auto font-mono text-ink">
            {typeof entry.value === 'number' ? formatValue(entry.value, unit) : 'no sample'}
          </span>
        </div>
      ))}
    </div>
  );
}

/** What a screen reader gets instead of the polyline. */
function describe(group: ChartGroup): string {
  const unit = group.unit ?? 'no unit';
  const parts = group.series.map((series) => {
    const range =
      series.min !== null && series.max !== null
        ? `from ${formatValue(series.min, group.unit)} to ${formatValue(series.max, group.unit)}`
        : 'no readings';
    const gaps =
      series.missing > 0
        ? `, ${series.missing} ${series.missing === 1 ? 'bucket' : 'buckets'} with no sample`
        : '';
    const last = series.last !== null ? `, last ${formatValue(series.last, group.unit)}` : '';
    const unitOf = series.samples === 1 ? 'bucket' : 'buckets';
    return `${series.name}: ${series.samples} ${unitOf}, ${range}${last}${gaps}`;
  });
  return `${unit}. ${parts.join('. ')}.`;
}

export function MetricChart({
  group,
  range,
  showAxis,
}: {
  group: ChartGroup;
  range: TimeRange;
  showAxis: boolean;
}) {
  const spanMs = range.to.getTime() - range.from.getTime();
  const [domainMin, domainMax] = axisDomain(group.unit, group.max);

  return (
    <section className="border-t border-line pt-3 pb-1 first:border-t-0">
      <header className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5 px-5 sm:px-8">
        <h2 className="font-mono text-[12px] text-ink-dim">{group.unit ?? 'unitless'}</h2>
        <ul className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          {group.series.map((series) => (
            // `whitespace-nowrap`: without it a narrow screen breaks the line
            // between a number and its unit, so "4 330 MiB" reads as two
            // separate figures. The list wraps between items, never inside one.
            <li key={series.name} className="flex items-center gap-1.5 whitespace-nowrap">
              <SeriesSwatch series={series} />
              <span className="font-mono text-[11px] text-ink-dim">{series.name}</span>
              <span className="font-mono text-[12px] font-medium text-ink">
                {series.last === null ? '-' : formatValue(series.last, group.unit)}
              </span>
              {series.min !== null && series.max !== null && series.min !== series.max && (
                <span className="font-mono text-[11px] text-ink-muted">
                  {formatValue(series.min, group.unit)} to {formatValue(series.max, group.unit)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </header>

      {/* The numbers behind the polyline, in browse-mode-readable markup.
          The svg <title> above names the chart; this carries the readings. */}
      <p className="sr-only">{describe(group)}</p>

      <div className={showAxis ? 'h-40 pr-2 sm:pr-5' : 'h-32 pr-2 sm:pr-5'}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={group.rows}
            syncId="mona-timeline"
            // `accessibilityLayer` makes the chart a focusable
            // role="application" the arrow keys walk through - and, on its
            // own, an unnamed one: four tab stops that announce "application"
            // and nothing else. `title` renders the <title> inside the svg,
            // which is what gives that stop its accessible name, and it names
            // the series rather than leaving them identified by colour.
            accessibilityLayer
            title={`${group.unit ?? 'unitless'} over time: ${group.series
              .map((series) => series.name)
              .join(', ')}`}
            // The right margin is identical on every strip, including the ones
            // with a hidden axis: the plot areas have to start and end at the
            // same x or reading a spike down the stack stops working. 28 is
            // what the last time tick needs, which was clipped at 4.
            margin={{ top: 8, right: 28, bottom: 8, left: 4 }}
          >
            <CartesianGrid stroke="var(--color-bg-800)" strokeDasharray="0" vertical={false} />

            {/* Stretches where nothing arrived from anything in this group. Drawn
                under the lines so a band never hides a reading, and repeated on
                every strip so an outage reads as one vertical column down the
                whole page. */}
            {group.bands.map((band) => (
              <ReferenceArea
                key={band.from}
                x1={band.from}
                x2={band.to}
                fill="var(--color-bg-900)"
                fillOpacity={1}
                stroke="none"
                ifOverflow="hidden"
                // Named once, on the strip that carries the time axis, and
                // only where the band is wide enough to hold the words. A
                // shaded region alone is a convention; the words are a fact,
                // and without them a reader can as easily take the shading for
                // a selection as for an absence.
                label={
                  showAxis && band.to - band.from > spanMs * 0.08
                    ? {
                        value: 'no samples',
                        position: 'insideBottom',
                        fill: 'var(--color-ink-muted)',
                        fontSize: 11,
                        fontFamily: 'var(--font-mono)',
                      }
                    : undefined
                }
              />
            ))}

            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[range.from.getTime(), range.to.getTime()]}
              hide={!showAxis}
              tickFormatter={(value: number) => formatTick(value, spanMs)}
              tick={{
                fill: 'var(--color-ink-muted)',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
              }}
              tickLine={false}
              axisLine={{ stroke: 'var(--color-line)' }}
              minTickGap={48}
            />
            <YAxis
              // Fixed, and the same on every strip, so the plot areas line up.
              // 56 fits the widest tick this formatter produces ("439,5K" at
              // 11px mono) and gives a 390px phone back the 12px that 68 cost.
              width={56}
              domain={[domainMin, domainMax]}
              ticks={axisTicks(group.unit)}
              tickCount={4}
              tickFormatter={(value: number) => formatAxisValue(value, group.unit)}
              tick={{
                fill: 'var(--color-ink-muted)',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
              }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              cursor={{ stroke: 'var(--color-line-strong)', strokeWidth: 1 }}
              content={(props: TooltipContentProps) => (
                <ChartTooltip {...props} unit={group.unit} />
              )}
            />

            {group.series.map((series) => (
              <Line
                key={series.name}
                type="linear"
                name={series.name}
                dataKey={(row: GridRow) => row.values[series.name]}
                stroke={series.color}
                strokeWidth={STROKE_WIDTH}
                strokeDasharray={series.dash}
                dot={false}
                activeDot={{ r: 2.5, strokeWidth: 0 }}
                // Off deliberately. A line that draws itself on every
                // progressive arrival is motion that tells the reader nothing
                // about what changed, and there are up to eight of them.
                isAnimationActive={false}
                // The default. Spelled out because it is the single behaviour
                // this whole file exists to get right: a bucket with no sample
                // is a hole in the line, never a zero and never a straight
                // segment drawn across it.
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
