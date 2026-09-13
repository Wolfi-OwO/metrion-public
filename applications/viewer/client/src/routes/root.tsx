import { useOutletContext } from 'react-router-dom';
import type { AuthState } from '../lib/use-auth.ts';
import DashboardRoute from './dashboard.tsx';
import LandingRoute from './landing.tsx';

/**
 * `/` is one URL with two screens behind it: the marketing landing page for
 * a signed-out visitor, the project list for a signed-in one. Splitting them
 * into two routes would need a redirect either way for a bookmark to `/`,
 * which is worse than the one status check this does instead.
 */
export default function RootRoute() {
  const auth = useOutletContext<AuthState>();

  if (auth.status === 'loading') {
    return (
      <main className="flex flex-1 items-center justify-center px-5 py-14 sm:px-8">
        <p role="status" aria-live="polite" className="text-[13px] text-ink-dim">
          Loading…
        </p>
      </main>
    );
  }

  if (auth.status === 'signed-in' && auth.user) {
    return <DashboardRoute user={auth.user} onSignedOut={auth.refresh} />;
  }

  return <LandingRoute />;
}
