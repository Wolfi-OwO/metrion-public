import { useEffect, useRef, useState } from 'react';
import { ApiError, fetchSeries, type SeriesResult } from '../api/client.ts';
import type { TimeRange } from './range.ts';

/**
 * Loads one series per metric name and hands them back as they arrive.
 *
 * Progressive on purpose, not for polish. `GET /api/v1/metrics` answers for
 * exactly one metric name, and the service behind it re-reads every day-blob
 * in the range for each call - so a host with eighteen metric names costs
 * eighteen full scans. Waiting for all eighteen before drawing anything would
 * leave the page empty for as long as the slowest of them takes; appending
 * each result as it lands fills the stack top-down instead, and `loaded` gives
 * the header an honest "5 of 18" rather than a spinner.
 *
 * ponytail: the real fix is a batch read on the server - `name` accepted more
 * than once, one scan, N series back - which would turn eighteen requests and
 * eighteen scans into one. That is an API change, so it is not this file's to
 * make. Until then, concurrency is capped at three: enough to hide latency,
 * low enough not to spend the viewer's global rate-limit budget or run three
 * hundred megabytes of blob download in parallel.
 */
const CONCURRENCY = 3;

/** Matches `WAKE_AFTER_MS` in `use-loader.ts` - one cold-start threshold, two callers. */
const WAKE_AFTER_MS = 1200;

export interface SeriesLoad {
  readonly phase: 'loading' | 'waking' | 'ready' | 'error';
  readonly results: SeriesResult[];
  readonly loaded: number;
  readonly total: number;
  readonly error: ApiError | null;
  readonly elapsedSeconds: number;
}

export interface SeriesRequest {
  readonly resource: string;
  readonly subResource?: string | undefined;
  readonly names: readonly string[];
  readonly range: TimeRange;
  readonly stepSeconds: number;
}

export function useSeries(request: SeriesRequest | null, attempt: number): SeriesLoad {
  const [load, setLoad] = useState<SeriesLoad>({
    phase: 'loading',
    results: [],
    loaded: 0,
    total: 0,
    error: null,
    elapsedSeconds: 0,
  });

  // The request object is rebuilt on every render; the key is what decides
  // whether the data actually changed, so a re-render cannot restart a fetch.
  const key = request
    ? JSON.stringify([
        request.resource,
        request.subResource ?? '',
        request.names,
        request.range.from.toISOString(),
        request.range.to.toISOString(),
        request.stepSeconds,
      ])
    : '';
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    const current = requestRef.current;
    if (!current || current.names.length === 0) {
      setLoad({
        phase: 'ready',
        results: [],
        loaded: 0,
        total: 0,
        error: null,
        elapsedSeconds: 0,
      });
      return;
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    const results: SeriesResult[] = [];
    const names = [...current.names];
    let cursor = 0;

    setLoad({
      phase: 'loading',
      results: [],
      loaded: 0,
      total: names.length,
      error: null,
      elapsedSeconds: 0,
    });

    const ticker = setInterval(() => {
      setLoad((previous) =>
        previous.phase === 'loading' || previous.phase === 'waking'
          ? { ...previous, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) }
          : previous,
      );
    }, 1000);

    const wakeTimer = setTimeout(() => {
      setLoad((previous) =>
        previous.phase === 'loading' ? { ...previous, phase: 'waking' } : previous,
      );
    }, WAKE_AFTER_MS);

    async function worker(): Promise<void> {
      while (cursor < names.length && !controller.signal.aborted) {
        const name = names[cursor++];
        if (name === undefined) return;
        const result = await fetchSeries(
          {
            resource: current!.resource,
            subResource: current!.subResource,
            name,
            from: current!.range.from,
            to: current!.range.to,
            stepSeconds: current!.stepSeconds,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        results.push(result);
        // A copy per arrival: React compares by identity, and the whole point
        // is that the stack grows while the rest is still in flight.
        setLoad((previous) => ({ ...previous, results: [...results], loaded: results.length }));
      }
    }

    Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker))
      .then(() => {
        if (controller.signal.aborted) return;
        setLoad((previous) => ({ ...previous, phase: 'ready', results: [...results] }));
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setLoad((previous) => ({
          ...previous,
          phase: 'error',
          error:
            cause instanceof ApiError
              ? cause
              : new ApiError(null, cause instanceof Error ? cause.message : 'Unknown failure.'),
        }));
      })
      .finally(() => {
        clearInterval(ticker);
        clearTimeout(wakeTimer);
      });

    return () => {
      controller.abort();
      clearInterval(ticker);
      clearTimeout(wakeTimer);
    };
  }, [key, attempt]);

  return load;
}
