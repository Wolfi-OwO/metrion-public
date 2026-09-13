import { Brand } from '../components/brand.tsx';
import { CopyButton } from '../components/copy-button.tsx';

/**
 * The signed-out root. A quiet, technical product page rather than a
 * marketing hero: this tool's own audience reads a curl command faster than
 * a tagline, so the quickstart snippet - not an illustration - is the
 * page's proof.
 */

const PROVIDERS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: 'google', label: 'Continue with Google' },
  { id: 'microsoft', label: 'Continue with Microsoft' },
  { id: 'github', label: 'Continue with GitHub' },
];

/** Real navigations to `GET /auth/:provider` (`routes/auth.routes.ts`), not
 * fetches - the server answers with a redirect to the provider, so a plain
 * anchor is correct and a click handler would only get in the way. */
function SignInButtons() {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap" aria-label="Sign in">
      {PROVIDERS.map((provider) => (
        <a
          key={provider.id}
          href={`/auth/${provider.id}`}
          className="rounded-sm border border-line-strong bg-bg-800 px-4 py-2 text-center text-[13px] font-medium text-ink transition-colors duration-150 hover:border-series-1 hover:text-series-1"
        >
          {provider.label}
        </a>
      ))}
    </div>
  );
}

const RESOURCE_KINDS: ReadonlyArray<readonly [scope: string, examples: string]> = [
  ['Host', 'cpu.usage, memory.used, disk.root.usedPercent'],
  ['Container', 'container:<name> - restarts, memory, cpu'],
  ['Request host', 'requests:<host> - latency, status counts'],
];

/** A real request against the real ingest schema
 * (`applications/ingest/src/schemas/ingest.schemas.ts`) - the placeholder
 * key and host are the only invented parts. `metrion.example.at` matches the
 * placeholder domain already used in `applications/viewer/.env.example`. */
const QUICKSTART = `curl https://ingest.metrion.example.at/api/v1/ingest \\
  -H "Authorization: Bearer mtr_<prefix>_<secret>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "resource": "vps-01",
    "metrics": [
      { "name": "cpu.usage", "value": 42.5, "unit": "percent",
        "intervalSeconds": 60, "timestamp": "2026-09-13T12:00:00Z" }
    ]
  }'`;

export default function LandingRoute() {
  return (
    <>
      <header className="border-b border-line px-5 py-4 sm:px-8">
        <Brand />
      </header>

      <main className="flex-1">
        <section className="border-b border-line px-5 py-14 sm:px-8 sm:py-20">
          <div className="max-w-2xl">
            <h1 className="text-[28px] font-semibold leading-tight text-ink sm:text-[34px]">
              One shared time axis for every server you run.
            </h1>
            <p className="mt-4 max-w-prose text-[15px] leading-relaxed text-ink-dim">
              metrion collects CPU, memory, disk, network and per-container metrics once a minute
              and lines every reading up against the same clock, so a CPU spike and a network spike
              read as one instant, not two dashboards you have to cross-reference by hand.
            </p>
            <div className="mt-8">
              <SignInButtons />
            </div>
          </div>
        </section>

        <section className="border-b border-line px-5 py-10 sm:px-8">
          <h2 className="font-mono text-[12px] text-ink-dim">What it tracks</h2>
          <table className="mt-4 w-full max-w-2xl border-collapse text-left">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-muted">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Scope
                </th>
                <th scope="col" className="py-2 font-medium">
                  Example metrics
                </th>
              </tr>
            </thead>
            <tbody>
              {RESOURCE_KINDS.map(([scope, examples]) => (
                <tr key={scope} className="border-b border-line last:border-b-0">
                  <td className="py-2 pr-4 text-[13px] text-ink">{scope}</td>
                  <td className="py-2 font-mono text-[12px] text-ink-dim">{examples}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="px-5 py-10 sm:px-8">
          <h2 className="font-mono text-[12px] text-ink-dim">
            Already have a key? Send your first metric.
          </h2>
          <div className="mt-4 max-w-2xl">
            <pre className="overflow-x-auto rounded-sm border border-line bg-bg-900 p-4 font-mono text-[12px] leading-relaxed text-ink">
              <code>{QUICKSTART}</code>
            </pre>
            <div className="mt-2 flex justify-end">
              <CopyButton text={QUICKSTART} label="Copy snippet" />
            </div>
            <p className="mt-2 text-[12px] text-ink-muted">
              No key yet? Sign in above, create a project, then mint one from its settings page.
            </p>
          </div>
        </section>
      </main>
    </>
  );
}
