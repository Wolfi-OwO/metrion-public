import { Link } from 'react-router-dom';
import { Brand } from '../components/brand.tsx';
import { Body, Heading, Panel } from '../components/states.tsx';

/** The catch-all route. `App.tsx`'s footer still renders around this, so the
 * legal links stay reachable from a mistyped URL exactly as they do from
 * every other screen. */
export default function NotFoundRoute() {
  return (
    <>
      <header className="border-b border-line px-5 py-4 sm:px-8">
        <Brand />
      </header>
      <main className="flex-1">
        <Panel>
          <Heading>Page not found</Heading>
          <Body>
            There is nothing at this address.{' '}
            <Link to="/" className="text-series-1 hover:underline">
              Go back home
            </Link>
            .
          </Body>
        </Panel>
      </main>
    </>
  );
}
