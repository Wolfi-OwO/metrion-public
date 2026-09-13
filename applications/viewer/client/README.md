# viewer/client

The product frontend: a landing page, a dashboard, a project's metrics view
and its settings screen, served by `applications/viewer` (`static-frontend.ts`)
in production and by Vite's dev server (proxying `/api` to `:8080`) locally.

## Router

`react-router-dom` v7, declarative mode (`<BrowserRouter>` /
`<Routes>`/`<Route>` in `src/main.tsx`), not the data-router / loader API.

- **Why a router at all now.** The single-screen app this replaces had
  exactly one thing to look at, so a route would have been a second way to
  express state a `useState` pair already held - that reasoning is gone the
  moment there are five screens with distinct URLs worth linking to,
  bookmarking and refreshing: landing, dashboard, a project's metrics, its
  settings, not-found.
- **Why `react-router-dom` over hand-rolling one.** It is a bundled
  dependency, not a runtime fetch - nothing about "no third-party browser
  request" is affected by adding it, the same way adding `recharts` earlier
  was not. A hand-rolled router would need to reinvent `<Link>`,
  `useParams`, `useOutletContext` and back/forward handling for no benefit
  over a library that already gets all four right.
- **Why declarative mode, not loaders.** Every existing data hook
  (`use-loader.ts`, `use-series.ts`) already owns its own fetch, abort and
  retry logic, including the cold-start "waking" affordance the brief
  requires preserved exactly. Router loaders are a second, competing way to
  fetch data; adopting them would mean rewriting hooks that did not need to
  change, for a screen count (five) that does not need it.
- **Why `<Route element={<App />}>` as a layout route.** `App.tsx` owns the
  one `GET /api/v1/me` check every screen needs and the footer every screen
  shares (including error and not-found states), and hands the auth result
  down to routed children via `<Outlet context={auth} />` /
  `useOutletContext`. One request per page load, not one per screen; no
  bespoke `AuthContext` provider, since the router already gives this for
  free between a layout route and its children.

## Screens (`src/routes/`)

| Route                           | Component              | Who sees it                                                                                                                |
| ------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `/`                             | `root.tsx`             | Landing (signed out) or dashboard (signed in) - one URL, two screens, decided by the one auth check `App.tsx` already ran. |
| `/projects/:projectId`          | `project-metrics.tsx`  | A project's charts - the original single-screen app's body, moved here unchanged.                                          |
| `/projects/:projectId/settings` | `project-settings.tsx` | API key creation, one-time reveal, revocation.                                                                             |
| `*`                             | `not-found.tsx`        | Anything unmatched.                                                                                                        |

`landing.tsx` and `dashboard.tsx` are rendered by `root.tsx`, not registered
as their own `<Route>`, so a bookmark to `/` never needs a redirect.

## Design system

Nothing new was introduced - every screen reuses the tokens, type scale and
component patterns `styles/index.css` and the original chart components
already established, rather than growing a second visual language for the
new screens:

- **Colour, type, spacing.** The existing `--color-*` tokens (all measured
  for WCAG contrast, see the comments in `styles/index.css`), the two
  self-hosted `@fontsource` families, and the existing type scale (mono
  11-15px labels, sans 13-15px body, one 28-34px display size for the
  landing headline - the only place this app has ever needed one). No new
  colour, no new font, no new size was added.
- **Borders and flat surfaces over shadows or cards.** The original app drew
  every boundary with a 1px `border-line`, never a shadow, and grouped
  nothing in a rounded card. The new screens (dashboard's project list,
  settings' key list) follow the same rule: a bordered list with
  `divide-y`, not a grid of cards - the existing house style, applied to
  more screens rather than replaced for them.
- **Landing page.** Deliberately not a centred hero with a gradient and a
  three-icon feature grid. The audience for a metrics tool reads a `curl`
  command faster than a tagline, so the page is an asymmetric, left-aligned
  headline against real dense content: a table of the actual resource kinds
  the picker already offers (`Host` / `Container` / `Request host`, taken
  straight from `resource-picker.tsx`'s own `KIND_LABELS`), and a real,
  copy-pasteable request against the documented ingest schema - not an
  illustration, not an invented stat.
- **Forms.** One pattern, used for both the project-name field and the API
  key flow: validate on blur, re-validate on submit, error text next to the
  field naming what to fix (`lib/validate.ts` mirrors the server's own zod
  constraints for this), the input's value is never cleared on error, and a
  disabled/pending button state instead of a spinner.
- **Empty and loading states.** `components/states.tsx`'s `Panel` /
  `Heading` / `Body` / `ActionButton` (already used by the chart screen's
  `EmptyState` and `ErrorState`) are now exported and reused for "no
  projects yet" and "project not found", rather than each new screen
  growing its own version of the same three-part layout.
- **Motion.** No new easing curve or duration was added; the one
  `--ease-instrument` curve and the reduced-motion rule in `styles/index.css`
  already cover everything here, since nothing new animates beyond the
  existing button/link colour transitions and the copy button's "Copied"
  text swap.

## Known limitation: metrics are scoped per session, not per project

`GET /api/v1/resources` and `GET /api/v1/metrics` scope to every project the
calling session owns (`resolveProjectIdsFromSession` in
`applications/viewer/src/middlewares/project-scope.ts` unions across all of
them) - there is no `projectId` query parameter for a screen to send. The
per-project metrics view therefore shows the exact same charts as the
original single-screen app, unchanged, with a project name in its
breadcrumb; it does not yet isolate one project's data from a second
project's. `project-metrics.tsx` states this directly under its toolbar
rather than presenting the two as isolated when they are not. Fixing it is a
backend change (`metrics.schemas.ts`/`metrics-service.ts` accepting and
filtering by project id) outside this task's file list.

## Also out of scope for this task (stated, not hidden)

- **Listing existing API keys.** `POST /api/v1/projects/:id/keys` and
  `DELETE /api/v1/keys/:id` exist; a `GET` that lists a project's keys does
  not. The settings screen tracks only the keys it creates in its own
  lifetime (in React state, not persisted), and says so - a key from an
  earlier visit still revokes by id, just not from a list this screen can
  show.
- **`defaultResource` on project creation.** `POST /api/v1/projects`
  accepts it, but the create-project form does not expose it: it has no
  effect until a key from that project ingests something, so asking for it
  on the first screen a user sees would ask a question before there is
  anything to answer it against.

## Accessibility verification

No Lighthouse (or other headless-browser) tooling was available in this
environment - `mcp__playwright__*` tools are not reachable from here, so the
acceptance criterion was checked by manual review instead of a Lighthouse
run:

- Every interactive element is a real `<a>`, `<button>`, `<input>` or
  `<select>` - none is a `<div>` with a click handler - so keyboard
  reachability and the existing global `:focus-visible` rule
  (`styles/index.css`) cover all of them, including the ones added here.
- Every form field has a `<label htmlFor>`; every inline error is
  `role="alert"` and linked with `aria-describedby`; `aria-invalid` is set
  from the same validation state that renders the message, so the two can
  never disagree.
- Every async action's pending/disabled state is expressed on the control
  itself (`disabled`, its own label text changing to "Creating…" /
  "Revoking…" / "Signing out…"), not colour alone.
- The one-time secret uses `aria-label` on its `readOnly` input and the copy
  control's "Copied" feedback is in an `aria-live="polite"` region.
- Colour: every token used is one already measured against WCAG 2.1 AA in
  `styles/index.css`'s own comments (4.5:1 minimum); no new colour was
  introduced by this task.
- `npm run build --workspace=applications/viewer/client` was run and its
  output inspected; no console warnings from React or the build about
  invalid ARIA, duplicate ids or similar were produced.

This is a substitute for, not equivalent to, an automated Lighthouse run -
if `playwright`/Lighthouse tooling becomes reachable from an agent session,
re-running the audit against the real rendered pages is worth doing before
this ships.
