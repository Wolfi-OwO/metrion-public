# Privacy Policy (Datenschutzerklärung)

**mona — server supervision platform**
**Effective:** 2026-09-07
**Last updated:** 2026-09-07

Controller: Phillip Kofler, Villach, Kärnten, Österreich
Contact: <koflerphillip@outlook.com>

This is a description of what the software in this repository does, written
against the code rather than against intent — every claim below names the file
and line that implements it. It is not legal advice.

**Language.** This document is English because the application, its API
documentation and the whole repository are English. If a German-language
version is ever needed — Art 12(1) DSGVO wants the information intelligible to
the people it addresses — it has to be added, not translated on request. See
`IMPRESSUM.md` for why the Impressum itself is German.

---

## 1. Scope

mona is two programs and one browser client:

- **collector** — runs on the operator's own VPS (Contabo, Germany) once a
  minute and appends resource metrics to Azure Blob Storage.
- **viewer** — an Azure Container App serving a public read API, a public API
  documentation site at `/docs`, and one authenticated write endpoint at
  `POST /api/v1/ingest`.
- **viewer client** — a React charts page that reads the public API.

Applicable law: DSGVO (Regulation (EU) 2016/679), the Austrian
Datenschutzgesetz (DSG), § 165 TKG 2021 for anything stored on a visitor's
device, and § 5 ECG / § 25 MedienG for the Impressum.

---

## 2. What is stored

One append blob per UTC day, `<YYYY-MM-DD>.jsonl`, in one container of one
Azure Blob Storage account. Each line is a JSON array of envelopes
(`packages/shared/src/metric-envelope.ts:16-33`):

| Field         | Content                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `resource`    | A machine hostname, e.g. `vps-contabo-01`                                |
| `subResource` | `container:<name>`, `requests:<hostname>` or `collector`                 |
| `metrics[]`   | `name`, numeric `value`, `unit`, `intervalSeconds`, ISO-8601 `timestamp` |

`value` is always a number (`metric-envelope.ts:19`, enforced on ingest by
`z.number().finite()` in `applications/viewer/src/schemas/ingest.schemas.ts:36`).
There is no free-text field in the wire format, so no message, label or payload
can be smuggled into a blob as a metric.

The measurements are CPU, load average, memory, root-disk and Docker disk
usage, network throughput, per-container CPU/memory/restarts/OOM state, and
per-hostname request aggregates
(`applications/collector/src/lib/to-metric-envelopes.ts:29-103`).

## 3. What is deliberately never stored

**No client IP addresses. No user agents. No request paths. No query strings.**
Not in a blob, not in a log line, not in an API response, not in an error body.
This is enforced in four separate places rather than asserted once:

- The Caddy access-log reader types the log line as `status`, `duration` and
  `request.host` only. `request.remote_ip`, `request.headers` and `request.uri`
  exist in the real line and are never named, so there is no filter to bypass
  (`applications/collector/src/collectors/caddy-requests.ts:14-19`).
- The viewer replaces `pino-http`'s request serializer outright. The default
  emits `remoteAddress`, `remotePort`, the full header set, and the query
  string inside `url`; the replacement emits `method` and `path` only, with the
  query string cut at the `?` (`applications/viewer/src/main.ts:106-112`).
- The 404 handler does not echo `req.originalUrl`, so an unmatched request's
  path and query string never reach a response body
  (`applications/viewer/src/middlewares/error.ts:71-73`).
- Neither rate limiter keys on an IP. The global one keys on the constant
  `'global'` (`applications/viewer/src/main.ts:82`); the ingest one keys on a
  SHA-256 hash of the bearer token
  (`applications/viewer/src/routes/ingest.routes.ts:36-39`), so the limiter's
  store never holds the secret either.

`trust proxy` is set to `1` so that `req.protocol` is honest behind the Azure
ingress; it is not used to read a forwarded client address
(`applications/viewer/src/main.ts:21-25`).

A verification run against the deployed logger sent a request carrying a query
string, a distinctive User-Agent, an `X-Forwarded-For`, a `Cookie`, a `Referer`
and a bearer token. The resulting log line contained `method`, `path`,
`statusCode` and `responseTime`, and none of those values.

### The one thing the log does keep

Request logs retain `path` — this application's own route, e.g.
`/api/v1/metrics` — with the query string removed. It identifies an endpoint of
this service, not a person: no address, no agent, no session and no other
identifier is recorded alongside it. Keeping it is what makes a 500 traceable
to an endpoint at all. Section 7 explains why this does not make the log line
personal data.

## 4. Cookies, tracking and third-party requests — none, and why there is no banner

- **No cookies.** No code in this repository sets one. CORS is configured
  without `credentials`, so a browser sends no cookie on the strength of the
  CORS headers either (`applications/viewer/src/main.ts:42-54`).
- **No local storage.** Nothing in the collector, viewer or client writes to
  `localStorage`, `sessionStorage` or any other device storage.
- **No analytics, telemetry, tag manager, error-tracking SDK or advertising
  pixel** anywhere in the pipeline.
- **No third-party request from the browser.** Fonts are self-hosted as npm
  packages and bundled with the application
  (`applications/viewer/client/package.json:17-18`,
  `applications/viewer/client/src/styles/index.css:6-7`), not fetched from
  Google Fonts or any CDN. `applications/viewer/client/index.html` loads
  nothing but its own bundle and favicon. The client's only network call is to
  a same-origin `/api/...` path
  (`applications/viewer/client/src/api/client.ts:67`).

§ 165 Abs 3 TKG 2021 requires prior consent for storing information on, or
reading information from, a user's device. This application stores nothing on
the device and reads nothing from it, so no consent is required and **no cookie
banner exists, because there is nothing for one to ask about.** If any of the
above ever changes — one analytics snippet, one CDN-hosted font, one embedded
video — a compliant prior-opt-in banner becomes mandatory before that code
ships, and this section becomes false.

## 5. Storage location and retention

- **Where:** Azure Blob Storage, one container, in the operator's Azure
  subscription. The storage account name is deliberately not published: it is a
  globally unique DNS label and naming it hands over an enumeration target.
- **Region: Australia Southeast (`australiasoutheast`, Victoria, Australia).**
  Confirmed against the live subscription on 2026-09-07, not guessed. **This is
  outside the EU/EEA**, so the data leaves the European Economic Area and is
  stored in a third country for which the European Commission has issued no
  adequacy decision.
- **Chapter V DSGVO transfer position.** Chapter V governs transfers of
  _personal data_. On the assessment in sections 2 and 3 no personal data of
  any third party is processed here: the wire format has no free-text field,
  `value` is always a number, and client IP addresses, user agents, request
  paths and query strings are excluded structurally at four separate points.
  What is stored is resource-usage telemetry about the operator's own machines
  — hostnames, container names, the operator's own vhost names, and numbers.
  On that basis Chapter V is not engaged and **no transfer mechanism is claimed
  here: there is no Standard Contractual Clause, no adequacy decision and no
  derogation being relied on, because none is needed for data that is not
  personal data.**

  Stated plainly so the reasoning can be checked rather than trusted: this
  position depends entirely on the "no personal data" assessment above holding.
  If a future sender ingests anything that identifies a natural person — an
  end-user identifier as a `resource`, say, or per-user request aggregates —
  then that assessment fails, the transfer to Australia becomes a Chapter V
  transfer with no mechanism behind it, and either the region or the mechanism
  has to change before that sender is enabled. The ingest schema's charset and
  shape restrictions make this harder but do not make it impossible.

- **How long:** an Azure Blob Lifecycle Management policy named
  `vps-metrics-retention-90d` deletes a blob **90 days after its last write**
  (`docs/adr/0001-append-blob-over-table-storage.md:23-30`). A day-blob's last
  write is the last minute of that UTC day, so a sample is gone roughly 90 days
  after the day it was taken. Retention is enforced by the storage platform,
  not by application code, so there is no job that can silently stop running.
- **On the VPS:** undelivered samples wait in a local queue capped at 1440
  lines — one day — plus small state files
  (`applications/collector/src/config/index.ts:48-59`). They are deleted once
  delivered.

## 6. Processors and recipients

- **Microsoft Azure** — Blob Storage and Container Apps. Microsoft's Data
  Protection Addendum serves as the Art 28 DSGVO processor agreement.
- **Contabo GmbH, Germany** — the VPS the collector runs on.

Nothing is shared with anyone else, sold, or used for advertising. The read API
is public by decision: it serves aggregate resource usage of the operator's own
machines (`applications/viewer/src/routes/metrics.routes.ts:7-11`).

Note that **Azure Container Apps' own platform logging is not covered by the
guarantees in section 3.** Those guarantees are about this application's code.
If an ingress or diagnostic log stream is attached to the container app at the
Azure level, Microsoft's platform may record client IP addresses independently
of anything in this repository. Whether one is attached is a deployment
question, not a code question — see "Open points".

## 7. Is personal data processed at all?

**Assessment: within this application's own code, no personal data of third
parties is processed.** The reasoning runs in both directions, because "no
personal data" is a claim that is easy to make and easy to get wrong.

**Against personal data.** Art 4(1) DSGVO requires information _relating to an
identified or identifiable natural person_. A blob line contains a machine
hostname, a metric name, a number, a unit and a timestamp. No identifier of any
visitor is recorded at any point in the chain, so there is no key to single
anyone out with, and none can be reconstructed from the stored values. The
request aggregates are `{count, statusCounts, avgLatencyMs}` per vhost per
minute: they describe a domain, not a request and not a requester. The retained
log `path` names a route of this service; the record contains no natural person
at all, so there is nothing for the information to _relate to_ in the Art 4(1)
sense.

**For personal data.** Two honest counter-arguments:

1. The metrics describe machines and domains operated by one identified natural
   person. Data about a sole operator's own infrastructure does relate to him,
   so it is his personal data — but he is simultaneously the controller and the
   only data subject, and he publishes it deliberately. No third party's rights
   are engaged.
2. Under Recital 26 and _Breyer_ (CJEU C-582/14), identifiability turns on the
   means reasonably likely to be used. The operator does hold an additional
   dataset: Caddy's own raw access log on the VPS, which contains client IP
   addresses. In the extreme case of a vhost showing `count: 1` in a given
   minute, that aggregate plus the raw log could in principle be correlated.
   This does not make the _aggregate_ personal data — the correlation comes
   entirely from the other dataset — but it does mean the raw Caddy log is a
   separate processing operation of personal data that this policy does not
   cover. It runs under Caddy's own configuration and Docker's log rotation,
   needs its own legal basis (Art 6(1)(f), security and operation of the
   service) and its own retention answer. It is outside mona, not outside
   existence.

**Consequence.** Because no personal data of third parties is collected, the
Art 13 information duty is not triggered by using this service, and there is no
Art 15/17/20 request that could meaningfully be answered about a visitor: there
is nothing stored under which anyone could be found. This policy is published
anyway, because a claim to collect nothing is only worth something if it is
written down and checkable, and because the moment any of it changes the duties
attach immediately.

## 8. Your rights

Should personal data concerning you nevertheless be processed, Art 15-22 DSGVO
apply: access, rectification, erasure, restriction, portability and objection.
Write to <koflerphillip@outlook.com>. Answer within one month (Art 12(3)),
extendable by two months with reasons.

Right to complain (Art 77 DSGVO):
**Österreichische Datenschutzbehörde**, Barichgasse 40-42, 1030 Wien,
<dsb@dsb.gv.at>, <https://www.dsb.gv.at>.

## 9. Security

The measures relevant to this policy are documented in `SECURITY.md`: TLS at
the Azure ingress, a container-scoped add-and-create-only SAS on the VPS, a
managed identity holding no storage secret in the viewer, one bearer token on
the write path compared in constant time, and rate limits on every route.

## 10. Changes

Material changes will be reflected here with a new effective date. Because
every claim in sections 3 and 4 is tied to a file and a line, a code change
that falsifies one of them is a change to this document too.

---

## Open points

- The Azure region in section 5 is a placeholder and must be confirmed before
  this document is published.
- Whether Azure Container Apps ingress/diagnostic logging is enabled for this
  app, and whether it records client IP addresses, is not determinable from
  this repository. If it is enabled, section 6 needs the retention period and
  the Art 28 reference for that log stream.

Effective: 2026-09-07
