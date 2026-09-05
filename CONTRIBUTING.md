# Contributing

Single-maintainer project; this document exists mainly so the rules are
written down once instead of re-derived per change.

## Setup

```bash
npm install
```

## Workflow

```bash
npm run typecheck   # tsc -b, project references across packages/shared + applications/collector
npm run lint         # eslint
npm run format:check # prettier
npm --workspace applications/collector test  # builds, then runs the node:test self-check
```

## Deploying the collector

There is no CI/CD pipeline for this yet - the collector is deployed by hand:
build (`npm run build`), copy `applications/collector/dist/` to
`/opt/vps-metrics-collector/dist` on the VPS, restart nothing (it's a
systemd-timer one-shot, next tick picks up the new code). See the delivery
report for the exact systemd units and directory layout.
