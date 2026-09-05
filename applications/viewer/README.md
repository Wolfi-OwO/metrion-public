# viewer (reserved)

Not built yet - this is a follow-up project. It will be an Azure Container
App (`minReplicas: 0`, `maxReplicas: 1`) that reads the day-blobs
`applications/collector` writes to `vps-metrics/<YYYY-MM-DD>.jsonl` in Azure
Blob Storage and serves them, so the collector never talks to a Container
App directly (see the root README and `docs/adr/0001-*.md` for why).

Also the one place the planned overload alarm and the
`status.woofi-developments.at` CPU/RAM tiles should read from once this
exists - see `docs/adr/0002-one-metrics-source.md`.
