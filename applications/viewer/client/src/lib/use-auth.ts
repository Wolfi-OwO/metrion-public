import { useCallback, useEffect, useState } from 'react';
import { fetchMe, type MeResponse } from '../api/client.ts';

/**
 * The one `/api/v1/me` check every screen reads from, via `App.tsx`'s
 * `<Outlet context={auth} />` - one request per page load, not one per
 * route, and one place that decides "signed in" so a route never has to
 * re-derive it from a session cookie it cannot read anyway (httpOnly).
 */
export type AuthStatus = 'loading' | 'signed-in' | 'signed-out';

export interface AuthState {
  readonly status: AuthStatus;
  readonly user: MeResponse | null;
  readonly refresh: () => void;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<{ status: AuthStatus; user: MeResponse | null }>({
    status: 'loading',
    user: null,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, status: 'loading' }));

    fetchMe(controller.signal)
      .then((user) => {
        if (controller.signal.aborted) return;
        setState({ status: user ? 'signed-in' : 'signed-out', user });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // A failed check reads as signed-out rather than as a page-level
        // error: the visitor still gets the landing page, with the sign-in
        // buttons intact, instead of a dead screen behind a retry button for
        // a check nothing else on the page depends on.
        setState({ status: 'signed-out', user: null });
      });

    return () => controller.abort();
  }, [attempt]);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);

  return { ...state, refresh };
}
