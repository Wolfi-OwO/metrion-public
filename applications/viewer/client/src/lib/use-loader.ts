import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.ts';

/**
 * One request, one state machine, used by both loads in the app.
 *
 * `waking` is the reason this exists as its own phase. The viewer runs on
 * Azure Container Apps at `minReplicas: 0`, so the first request after an idle
 * period waits 5-15 seconds for a replica to start. A spinner is
 * indistinguishable from a hung request at that length, so after
 * `WAKE_AFTER_MS` the UI switches to a state that says what is happening and
 * counts the seconds out loud.
 */
export type LoadPhase = 'loading' | 'waking' | 'ready' | 'error';

/**
 * Long enough that an already-warm replica (single-digit milliseconds on the
 * blob cache, tens on a cold scan) never shows the waking copy, short enough
 * that a real cold start is explained before it starts to feel broken.
 */
const WAKE_AFTER_MS = 1200;

export interface LoadState<T> {
  readonly phase: LoadPhase;
  readonly data: T | null;
  readonly error: ApiError | null;
  /** Whole seconds since the in-flight request started; frozen once it settles. */
  readonly elapsedSeconds: number;
  readonly reload: () => void;
}

function asApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  return new ApiError(null, cause instanceof Error ? cause.message : 'Unknown failure.');
}

/**
 * `key` is what decides a re-fetch: change it and the previous request is
 * aborted, so a slow answer for last week can never land after a fast answer
 * for today and quietly overwrite the chart.
 */
export function useLoader<T>(
  key: string,
  run: (signal: AbortSignal) => Promise<T>,
  enabled = true,
): LoadState<T> {
  const runRef = useRef(run);
  runRef.current = run;

  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<LoadPhase>('loading');
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    const startedAt = Date.now();
    setPhase('loading');
    setError(null);
    setElapsedSeconds(0);

    const ticker = setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    const wakeTimer = setTimeout(() => setPhase('waking'), WAKE_AFTER_MS);

    runRef
      .current(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setPhase('ready');
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(asApiError(cause));
        setPhase('error');
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
  }, [key, attempt, enabled]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  return { phase, data, error, elapsedSeconds, reload };
}
