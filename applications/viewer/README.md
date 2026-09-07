# viewer

The Azure Container App (`minReplicas: 0`, `maxReplicas: 1`) that reads the
day-blobs `applications/collector` writes to `<YYYY-MM-DD>.jsonl` in Azure
Blob Storage and serves them. The collector never talks to this app - it
writes to the blob directly (see the root README and
`docs/adr/0001-*.md` for why). That container is still named `vps-metrics`
even though the repo is now mona - see "Why the server still says
vps-metrics" in `organizational/deployment-runbook.md`.

This is also the one place the planned overload alarm and the
`status.woofi-developments.at` CPU/RAM tiles should read from - see
`docs/adr/0002-one-metrics-source.md`.

## Endpoints

| Path                                   | Auth   | What                                                             |
| -------------------------------------- | ------ | ---------------------------------------------------------------- |
| `GET /api/v1/health/liveness`          | none   | Liveness probe. Exempt from the rate limiter.                    |
| `GET /api/v1/resources`                | none   | Distinct resources, sub-resources and metric names in a range.   |
| `GET /api/v1/metrics`                  | none   | One downsampled series. `from`/`to` required, at most 31 days.   |
| `POST /api/v1/ingest`                  | bearer | Append envelopes, for senders with no blob SAS. Rate limited.    |
| `GET /openapi.json`, `/docs`           | none   | The OpenAPI document and Swagger UI, generated from the schemas. |
| `GET /impressum`, `/privacy`, `/terms` | none   | The legal documents, rendered as HTML.                           |
| `GET /*`                               | none   | The React client, when its built assets are present.             |

The read endpoints are public by decision: this is aggregate resource usage
of my own machines, with no personal data in it. Only the write path is
authenticated.

## Layout

```
src/
├── main.ts             the whole startup file - app, middleware, listen
├── config/             the only place process.env is read
├── routes/             one file per surface, all mounted in routes/index.ts
├── handlers/           request in, response out
├── services/           the in-memory aggregation over the day-blobs
├── schemas/            zod - validation AND the source of the OpenAPI spec
├── lib/                blob reader/writer, legacy adapter, markdown
├── middlewares/        auth, validation, errors
└── static-frontend.ts  serves client/dist, never shadowing an API route
client/                 the React charts client (its own workspace)
```

## Running it

`INGEST_TOKEN` is required - the app refuses to start without one, because
booting without it would expose an unauthenticated write path to the same
blobs the collector writes.

```bash
cp .env.example .env
INGEST_TOKEN=$(openssl rand -hex 32) npm start
npm test
```

Reads use `DefaultAzureCredential` (managed identity in Azure, `az login`
locally) - deliberately not the collector's SAS token, which is add+create
only and can neither read nor list. With no storage account configured the
read endpoints answer 503 and everything else still works.
