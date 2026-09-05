# vps-metrics

The metrics pipeline for my Contabo VPS: a collector that reads CPU, RAM,
disk, network throughput, per-container stats and per-hostname request
counts off the box once a minute and ships them to Azure Blob Storage. A
viewer that reads them back is a follow-up project - this repo reserves
its place but doesn't build it yet.

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

## Tech stack

TypeScript/Node, npm workspaces - matching every other project in
`software-engineering/projects/web-apps/`. Deployed as a systemd timer, not
a container - see `organizational/deployment-runbook.md` for why (no image
builds on the VPS, and Node's own `apt` package is already there).

## Project structure

```
applications/
├── collector/     the minute-by-minute collector - this project
└── viewer/        reserved for the Azure Container App that reads the
                    data back - not built yet
packages/
└── shared/        MetricsSample - the wire format both sides agree on
docs/adr/          architecture decisions (storage type, one metrics source)
organizational/    the deployment runbook
```

## Getting started

```bash
npm install
npm run typecheck
npm --workspace applications/collector test   # builds, then the node:test self-check

# Run it locally without a real Azure SAS token:
cd applications/collector
cp .env.example .env   # then set DRY_RUN=true
node --env-file=.env dist/main.js
```

## Security

The VPS-side SAS token is scoped to exactly one container, with
add+create permissions only (no read/list/delete) - never the storage
account key. See `SECURITY.md` and the delivery report's Secrets section.

## Contributing

See `CONTRIBUTING.md`.

## License

Proprietary - see `LICENSE`.
