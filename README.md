# metrion

The server supervision platform for my infrastructure. Today that is one
metrics pipeline for my Contabo VPS: a collector that reads CPU, RAM,
disk, network throughput, per-container stats and per-hostname request
counts off the box once a minute and ships them to Azure Blob Storage, and
a viewer that reads them back - a public read API, an API documentation
site at `/docs`, an authenticated ingest endpoint, and a React charts
client.

The deploy path, state directory, systemd units and the Azure container on
the live box all still carry the old `vps-metrics` name; see
`organizational/deployment-runbook.md` for why they were deliberately left
alone.

I built it because three separate things were about to measure the same
numbers independently (this collector, a planned overload alarm, and a
planned CPU/RAM tile on my status page) - see
`docs/adr/0002-one-metrics-source.md` for why that's exactly the kind of
bug I've hit before and why there's now exactly one source instead.

## Features

- Minute-by-minute CPU%, load average, honest RAM usage (not the classic
  `free`-double-counts-cache mistake), root disk usage, Docker's own disk
  footprint (images/volumes/build-cache), network throughput on the box's
  real uplink, per-container CPU/RAM-vs-limit/restarts/OOM status, and
  per-hostname request counts/status codes/latency from Caddy's access log.
- No client IPs, no user agents, no request paths/query strings anywhere in
  the pipeline - see the delivery report's Privacy section.
- Zero runtime dependencies in the collector: stdlib `http`/`fs`/`os` only,
  including talking to the Docker Engine API and Azure's Blob REST API
  directly over their own protocols. Nothing to `npm install` on the VPS.
- Local queue with a bounded retry buffer if Azure is briefly unreachable -
  minutes aren't lost, and the buffer can't grow without limit either.
- A viewer that reads the day-blobs back: a public query API, a React
  charts client on one shared time axis, an OpenAPI documentation site at
  `/docs` generated from the same zod schemas the API validates with, and a
  token-authenticated ingest endpoint for senders that have no blob SAS.
- Both wire formats readable side by side: the viewer detects per blob line
  whether it is a pre-cutover sample or a `MetricEnvelope[]`, so a chart
  spanning the switch is continuous - see `docs/adr/0003-*.md`.

## Tech stack

TypeScript/Node, npm workspaces - matching every other project in
`software-engineering/projects/web-apps/`.

The **collector** is deployed as a systemd timer, not a container - see
`organizational/deployment-runbook.md` for why (no image builds on the VPS,
and Node's own `apt` package is already there). It runs on Node 18.19,
which is what Ubuntu 24.04 ships, so the root `engines` floor stays there.

The **viewer** is Express 4 + zod 4 on Node 22, with a React 19 / Vite /
Recharts client, built into one image and hosted on Azure Container Apps at
`minReplicas: 0`. The server serves the client's assets itself: one image,
one origin, no CORS in production and one thing to deploy.

## Project structure

```
applications/
├── agent/         the minute-by-minute collector - this project
└── viewer/        the Azure Container App that reads the data back:
                    read API, /docs, ingest endpoint, and client/ (React
                    charts)
packages/
└── shared/        MetricEnvelope - the wire format both sides agree on
docs/adr/          architecture decisions (storage type, one metrics source,
                    the generic envelope)
organizational/    the deployment runbook
.github/workflows/ lint, format, typecheck, build and test on every push
```

## Getting started

```bash
npm install
npm run typecheck
npm test          # every workspace: agent, viewer, client
npm run lint && npm run format:check
```

Run the collector locally without a real Azure SAS token:

```bash
cd applications/agent
cp .env.example .env   # then set DRY_RUN=true
node --env-file=.env dist/main.js
```

Run the viewer. `INGEST_TOKEN` is required - it refuses to start without
one, because booting without it would expose an unauthenticated write path:

```bash
cd applications/viewer
cp .env.example .env
INGEST_TOKEN=$(openssl rand -hex 32) npm start   # http://127.0.0.1:8080
npm --workspace @metrion/viewer-client run dev   # the client, on Vite
```

Or build the whole thing as the single image that is actually deployed.
Note it builds from the repository root, because npm workspaces need the
root manifest and lockfile:

```bash
docker build -f applications/viewer/Dockerfile -t metrion-viewer .
docker run --rm -p 8080:8080 -e INGEST_TOKEN=dummy metrion-viewer
```

## Security

The VPS-side SAS token is scoped to exactly one container, with
add+create permissions only (no read/list/delete) - never the storage
account key. See `SECURITY.md` and the delivery report's Secrets section.

## Legal

The viewer is reachable from the public internet, so it carries the same
legal surface as my other public projects. All three are also served by the
running app at `/impressum`, `/privacy` and `/terms` - § 5 ECG wants the
Impressum reachable from the deployed site, and a file in a Git repository
is not that:

- [`IMPRESSUM.md`](IMPRESSUM.md) - Offenlegung per § 5 ECG and § 25 MedienG.
- [`PRIVACY.md`](PRIVACY.md) - what is stored and what deliberately is not,
  with the file and line behind every claim. No cookies, no analytics, no
  tracking, no third-party request from the browser - and therefore no
  consent banner.
- [`TERMS_OF_USE.md`](TERMS_OF_USE.md) - who may use the read API and the
  ingest endpoint, and what a token holder answers for.

## Contributing

See `CONTRIBUTING.md`.

## License

Proprietary - see `LICENSE`.
