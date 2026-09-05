# Changelog

## Unreleased

- Add the metrics collector (`applications/collector`): reads CPU, RAM,
  disk, network throughput, per-container stats and per-hostname request
  counts off the VPS once a minute (systemd timer) and appends them to an
  Azure Blob Storage append blob, with local queueing/retry if Azure is
  briefly unreachable.
- Add `packages/shared`: the `MetricsSample` wire format both the
  collector and the future viewer read/write.
- Reserve `applications/viewer` for the Azure Container App that will read
  these samples back - out of scope for this change, follow-up project.
