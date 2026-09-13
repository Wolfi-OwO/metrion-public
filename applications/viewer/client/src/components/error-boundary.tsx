import { Component, type ReactNode } from 'react';
import { Body, Heading, Panel } from './states.tsx';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches a render-time crash in whichever route is active so the chrome
 * around it - `App.tsx`'s footer and its legal links - keeps rendering
 * instead of the whole page going blank. A React error boundary must be a
 * class; there is no hook equivalent for `getDerivedStateFromError`.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('A route crashed:', error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <main className="flex-1">
          <Panel>
            <div role="alert">
              <Heading>Something went wrong</Heading>
              <Body>
                This screen hit an unexpected error. Reloading the page usually clears it.
              </Body>
            </div>
          </Panel>
        </main>
      );
    }
    return this.props.children;
  }
}
