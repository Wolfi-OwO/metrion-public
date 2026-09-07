import { useMemo, useState } from 'react';
import { fetchResources } from './api/client.ts';
import { MetricChart } from './components/metric-chart.tsx';
import { RangeControl } from './components/range-control.tsx';
import { ResourcePicker, type Selection } from './components/resource-picker.tsx';
import { EmptyState, ErrorState, LoadingState } from './components/states.tsx';
import { formatAge, formatDuration, timeZoneLabel } from './lib/format.ts';
import { groupByUnit } from './lib/groups.ts';
import { chooseStepSeconds, RANGE_PRESETS, rangeFor } from './lib/range.ts';
import { useLoader } from './lib/use-loader.ts';
import { useSeries } from './lib/use-series.ts';

/**
 * The whole page. One screen, no router: there is exactly one thing to look at
 * here, and a route would only be a second way to express the two pieces of
 * state the header already holds.
 *
 * ponytail: selection and range live in `useState`, not in the URL. Add
 * `URLSearchParams` when a link to a specific window is worth sending to
 * somebody - it is a dozen lines and needs no library.
 */

const DEFAULT_PRESET = RANGE_PRESETS[2] ?? RANGE_PRESETS[0]!;

export default function App() {
  const [preset, setPreset] = useState(DEFAULT_PRESET);
  // Bumping `now` is what "Refresh" does: a new window end means a new range,
  // a new request key, and a reload of everything downstream. One trigger.
  const [now, setNow] = useState(() => new Date());
  const [selection, setSelection] = useState<Selection | null>(null);
  const [attempt, setAttempt] = useState(0);

  const range = useMemo(() => rangeFor(preset, now), [preset, now]);
  const stepSeconds = useMemo(() => chooseStepSeconds(range), [range]);
  const rangeKey = `${range.from.toISOString()}/${range.to.toISOString()}`;

  const resources = useLoader(rangeKey, (signal) => fetchResources(range.from, range.to, signal));

  const list = resources.data?.resources ?? [];

  /**
   * The selection is derived, not stored twice. A resource or sub-resource can
   * vanish when the range changes - it only existed in last week's data - and
   * a stored selection would then query something the API knows nothing about
   * and render an empty page with no explanation.
   */
  const active: Selection | null = useMemo(() => {
    const first = list[0];
    if (!first) return null;
    const found = selection && list.find((entry) => entry.resource === selection.resource);
    if (!found) return { resource: first.resource };
    if (selection?.subResource && !found.subResources.includes(selection.subResource)) {
      return { resource: found.resource };
    }
    return selection;
  }, [list, selection]);

  const activeEntry = list.find((entry) => entry.resource === active?.resource);

  const series = useSeries(
    active && activeEntry
      ? {
          resource: active.resource,
          subResource: active.subResource,
          names: activeEntry.metricNames,
          range,
          stepSeconds,
        }
      : null,
    attempt,
  );

  const groups = useMemo(
    () => groupByUnit(series.results, range, stepSeconds),
    [series.results, range, stepSeconds],
  );

  const newestSample = useMemo(() => {
    let newest = 0;
    for (const result of series.results) {
      const last = result.points[result.points.length - 1];
      if (!last) continue;
      const at = Date.parse(last.timestamp);
      if (at > newest) newest = at;
    }
    return newest;
  }, [series.results]);

  const skippedLines = (resources.data?.skippedLines ?? 0) + (series.results[0]?.skippedLines ?? 0);
  const presetIndex = RANGE_PRESETS.indexOf(preset);
  const widerPreset = RANGE_PRESETS[presetIndex + 1] ?? null;
  const selectionLabel = active
    ? active.subResource
      ? `${active.resource} / ${active.subResource}`
      : active.resource
    : 'any resource';

  const refresh = () => {
    setNow(new Date());
    setAttempt((value) => value + 1);
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-bg-900">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-2.5 sm:px-8">
          <h1 className="font-mono text-[15px] font-semibold tracking-tight text-ink">mona</h1>

          {list.length > 0 && active && (
            <ResourcePicker resources={list} value={active} onChange={setSelection} />
          )}

          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
            {newestSample > 0 && (
              <span className="font-mono text-[11px] text-ink-muted">
                last sample {formatAge(now.getTime() - newestSample)}
              </span>
            )}
            <RangeControl value={preset} onChange={setPreset} />
            <button
              type="button"
              onClick={refresh}
              className="rounded-sm border border-line-strong px-2.5 py-1 text-[12px] text-ink-dim transition-colors duration-150 hover:border-series-1 hover:text-series-1"
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Determinate, because the count is known: eighteen metric names mean
            eighteen requests. A determinate bar is the difference between
            "this is going to take a moment" and "this may never end". */}
        {(series.phase === 'loading' || series.phase === 'waking') && series.total > 0 && (
          <div
            className="h-px w-full bg-bg-800"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={series.total}
            aria-valuenow={series.loaded}
            aria-label="Loading metrics"
          >
            <div
              className="h-px bg-series-1 transition-[width] duration-300 ease-[var(--ease-instrument)]"
              style={{ width: `${(series.loaded / series.total) * 100}%` }}
            />
          </div>
        )}
      </header>

      {/* Called, not rendered as <Body />: a component declared inside another
          component is a new type on every render, so React would unmount and
          rebuild the whole chart tree - and recharts' hover state with it -
          every time the header ticks. */}
      <main>{renderBody()}</main>

      {/* Outside `renderBody` deliberately. Every branch in there can replace
          the whole page - a cold start, an empty range, a dead API - and § 5
          ECG wants the Impressum "leicht und unmittelbar zugaenglich", which it
          would not be if reaching it depended on the metrics API answering.
          Plain anchors, not routes: these are three server-rendered documents,
          not screens of this app, and a full page load is the correct
          behaviour. See the hand-off note for what has to serve them. */}
      <footer className="border-t border-line px-5 py-4 sm:px-8">
        <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-1 text-[11px]">
          {/* The Impressum keeps its German name: it is the word an Austrian
              reader looks for, and translating it would hide it. `lang` so a
              screen reader does not read it with an English voice. */}
          <a
            lang="de"
            href="/impressum"
            className="text-ink-dim underline underline-offset-2 transition-colors duration-150 hover:text-ink"
          >
            Impressum
          </a>
          <a
            href="/privacy"
            className="text-ink-dim underline underline-offset-2 transition-colors duration-150 hover:text-ink"
          >
            Privacy
          </a>
          <a
            href="/terms"
            className="text-ink-dim underline underline-offset-2 transition-colors duration-150 hover:text-ink"
          >
            Terms of use
          </a>
        </nav>
      </footer>
    </div>
  );

  function renderBody() {
    if (resources.phase === 'error' && resources.error) {
      return <ErrorState error={resources.error} onRetry={resources.reload} />;
    }
    if (resources.phase === 'loading' || resources.phase === 'waking') {
      return (
        <LoadingState waking={resources.phase === 'waking'} seconds={resources.elapsedSeconds} />
      );
    }
    if (list.length === 0) {
      return (
        <EmptyState
          range={range}
          label="any resource"
          onWiden={widerPreset ? () => setPreset(widerPreset) : null}
        />
      );
    }
    if (series.phase === 'error' && series.error) {
      return <ErrorState error={series.error} onRetry={() => setAttempt((v) => v + 1)} />;
    }
    if (groups.length === 0) {
      if (series.phase === 'ready') {
        return (
          <EmptyState
            range={range}
            label={selectionLabel}
            onWiden={widerPreset ? () => setPreset(widerPreset) : null}
          />
        );
      }
      return <LoadingState waking={series.phase === 'waking'} seconds={series.elapsedSeconds} />;
    }

    return (
      <>
        <div className="py-2">
          {groups.map((group, index) => (
            <MetricChart
              key={group.unit ?? 'unitless'}
              group={group}
              range={range}
              showAxis={index === groups.length - 1}
            />
          ))}
        </div>

        <div className="border-t border-line px-5 py-4 text-[11px] leading-relaxed text-ink-muted sm:px-8">
          <p>
            Times in {timeZoneLabel()}; the collector records in UTC. Each point is a{' '}
            {formatDuration(stepSeconds)} average, and a gap in a line is a bucket that held no
            sample - never a zero. Shaded columns are stretches where nothing at all was recorded.
          </p>
          {(series.phase === 'loading' || series.phase === 'waking') && (
            <p className="mt-1 text-ink-dim">
              Loaded {series.loaded} of {series.total} metrics.
            </p>
          )}
          {skippedLines > 0 && (
            <p className="mt-1 text-series-2">
              {skippedLines} unreadable {skippedLines === 1 ? 'line was' : 'lines were'} skipped in
              storage, so this window may be missing points.
            </p>
          )}
        </div>
      </>
    );
  }
}
