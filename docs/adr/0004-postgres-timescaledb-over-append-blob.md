# ADR 0004: Postgres/TimescaleDB over the append-blob store, self-hosted

## Status

Accepted, 2026-09-12. Supersedes ADR 0001.

## Context

ADR 0001 named its own exit condition: reading "just the last 5 minutes"
means downloading the current day's blob and filtering, not a targeted range
query - "acceptable at one VPS's worth of data; would need reconsidering if
this ever collects from many hosts into one container." Multi-tenant
accounts (Task 6) are exactly that condition. Once more than one account's
data lands in the same store, the query has to be scoped to the caller's own
rows before it does anything else, and an in-memory scan cannot do that: it
does not know who is asking.

`applications/viewer/src/services/metrics-service.ts:10-18` (`getResources`
and `getSeries`, via `forEachEnvelope`) parses every line of every day-blob
in the requested range into memory and then filters - `resource`,
`subResource` and metric name are all filtered _after_ the parse, not before
it. That is fine when there is one sender and no access boundary. It is not
an access-scoping mechanism: nothing about a JSONL line says which account
is allowed to see it, so scoping "only this project's rows" would mean
threading a project id through every blob or building a second index next
to the blobs - new infrastructure built to simulate the thing a database
already does. That is the property that actually forces this move, not
data volume by itself.

## Decision

Metrics move from newline-delimited JSON in Azure Append Blobs to a
Postgres database with the TimescaleDB extension, self-hosted (see
`## Hosting` below). `project_id` becomes a real column in a real index
(`packages/db` schema, Task 3), so a query is scoped by `WHERE project_id =
$1` before any row is read, not by an application-level filter after an
unscoped scan.

This explicitly supersedes both `ponytail:` markers in
`applications/viewer/src/services/metrics-service.ts`:

- The file-header marker (lines 10-18) says the upgrade path for a slow
  month-long range is "write pre-aggregated hourly rollup blobs alongside
  the raw days ... the rollup is a file - do not reach for a database
  first." The rollup this ADR ships is TimescaleDB's `metrics_hourly`
  continuous aggregate (Task 3) - a materialized, incrementally-refreshed
  rollup that is a first-class object in the same store as the raw rows,
  not a second file format the viewer has to know how to merge with the
  first.
- The `forEachEnvelope` marker (lines 35-38) says the same thing about
  latency: "sequential, so a 31-day range costs 31 round trips instead of
  one fan-out ... upgrade path when that latency starts to matter: the
  pre-aggregated hourly rollup blobs described in the file header, NOT a
  wider fan-out." Once the rollup is a continuous aggregate, "31 round
  trips" stops being the shape of the query at all - the range is one
  indexed read, whether it spans a day or a year.

Both markers were correct calls at the time: a database was not
justified when there was one sender and no access boundary to enforce.
Multi-tenancy is the trigger that changes that answer.

## Hosting

The engine decision (Postgres + TimescaleDB) and the host decision (where
it runs) share one trigger, so both are recorded here rather than in a
separate ADR.

1. **The trigger.** The host was originally scoped as Azure Database for
   PostgreSQL Flexible Server. A hard budget ceiling was then set: free, or
   at most $1-3/month, for a dataset expected to grow continuously. Managed
   Azure Postgres does not fit that ceiling - cheapest burstable compute
   plus meaningful storage runs roughly $12-15/month once the 12-month
   free-trial window closes (**not independently verified - confirm current
   Azure pricing before committing spend**).

2. **The second, independent reason, which would have applied without any
   budget.** Azure Database for PostgreSQL Flexible Server offers the
   **Apache-2 build** of the `timescaledb` extension, which ships **no
   compression, no continuous aggregates, and no `add_retention_policy`** -
   the three features this schema (Task 3) is built on. The managed host
   was therefore likely to fail its own pre-flight gate regardless of cost.
   (**Not independently verified - re-check Azure's current extension
   licensing if the managed option is ever reconsidered.**)

3. **The decision.** TimescaleDB runs self-hosted in Docker on the existing
   Contabo VPS - the same machine `applications/agent` already runs on -
   using the `timescale/timescaledb-ha` image at a pinned tag,
   `timescale/timescaledb-ha:pg17`, the same image and tag
   `docker-compose.dev.yml` uses for local dev. Incremental infrastructure
   cost: **zero**. The image ships the TSL community edition, so
   compression, continuous aggregates and retention policies are all
   available; Task 3's gate measures `SHOW timescaledb.license;` on this
   image rather than on a managed server whose answer we cannot influence.

   - **Measured licence tier (Task 3 gate, `SHOW timescaledb.license;`
     against `timescale/timescaledb-ha:pg17`):** `timescale` (TSL
     community edition) - the expected branch, no contingency needed.
   - **Measured `timescaledb` extension version** (`pg_available_extensions`,
     same container): 2.30.0.
   - **Pinned image tag (local dev and the production deploy alike):**
     `timescale/timescaledb-ha:pg17` - confirmed against the running
     container, not assumed.

4. **What "huge amount of data" actually means here, with the arithmetic
   written out.** The 90-day retention policy plus compression-after-7-days
   makes the dataset a **steady state, not a growth curve**. Derived
   estimate at the agent's current cadence (~37 metrics/minute, ~53k
   rows/day, ~100 bytes/row with index overhead): ~5 MB/day raw, settling
   at roughly **0.3-0.6 GB per tenant-host, flat**. This is a derived
   estimate, not a measurement.

   **Measured (Task 3 seed run, `hypertable_detailed_size('metrics')`
   after seeding 54,720 rows - 38 series x 1440 minutes, ~38 metrics/minute,
   one synthetic UTC day, one tenant-host, before the 7-day compression
   policy has touched this chunk):**
   `table_bytes 6,086,656`, `index_bytes 9,322,496`, `toast_bytes 16,384`,
   `total_bytes 15,425,536` - roughly **14.7 MB/day-per-tenant-host
   uncompressed**, about 3x the derived raw-only estimate because the two
   indexes here (`metrics_series_idx`, `metrics_project_time_idx`) run
   larger than the per-row overhead the derivation folded them into. This
   is the size of the most recent, not-yet-compressed chunk; the retention
   arithmetic in this ADR describes the steady state _after_
   compression-after-7-days, which this measurement does not directly show
   - only the pre-compression size of one fresh day is measured here.

5. **What of ADR 0001 survives, and in what form.** ADR 0001 is superseded
   on its query model (whole-file in-memory scan, no per-tenant scoping),
   but two of its principles are re-adopted rather than reversed:

   - _Retention must be enforced by the storage platform, not by a second
     job anyone has to babysit._ Previously a Blob Lifecycle Management
     policy; now a TimescaleDB retention policy (`add_retention_policy`,
     Task 3) dropping chunks past 90 days. Still zero application code.
   - _This is cheap at this volume on one machine._ Previously an argument
     for blobs on the storage account; now literally the same machine -
     the Contabo VPS already runs `applications/agent`.

   The supersession is a change in query model forced by multi-tenancy, not
   a reversal of the earlier reasoning about cost or operational burden.

6. **What the near-$0 host costs.** A single machine: no managed failover,
   no automatic point-in-time recovery. Backups become ours to run (a later
   infra task owns them). Network latency from Azure Container Apps
   (westeurope) to Contabo is roughly 10-25 ms, which is irrelevant at this
   row rate and must not be confused with the 24.4 s cross-continent
   problem recorded in `organizational/viewer-deployment-runbook.md:21-25`;
   co-locating the database with the compute buys nothing at this scale.
   The agent's existing on-disk retry queue
   (`applications/agent/src/lib/queue.ts`) means a VPS reboot costs queued
   minutes, not lost samples.

7. **The licence position.** The TSL permits self-hosted use inside a
   commercial product and prohibits offering the database itself as a
   managed service; Metrion exposes an HTTP metrics API, not SQL access to
   this database. **This is an interpretation, not verified legal advice -
   the TSL text is read and this paragraph confirmed before the repository
   goes public.**

8. **Measured network facts, cited to file and line.**
   `organizational/viewer-deployment-runbook.md:27-35` records that the VPS
   cannot reach Azure Storage's West Europe endpoints, while Australia
   Southeast, `management.azure.com`, and Container Apps FQDNs are all
   reachable from that host. That measurement covered outbound-from-VPS
   only. The reverse direction - Azure Container Apps outbound to the VPS
   on the Postgres port - was **not** covered by it and is measured in a
   later infra task, before the ingest/viewer services (Tasks 4-5) are
   pointed at this database in production.

## Consequences

- Queries are scoped by an indexed `project_id` before any row is read,
  which is what makes per-tenant access control possible at all - the
  property ADR 0001's model could not provide.
- The rollup and the retention policy are both properties of the storage
  platform (TimescaleDB), matching ADR 0001's original intent that neither
  should be a second job anyone has to babysit.
- The dataset is a steady state under retention + compression, not an
  unbounded growth curve, at an estimated 0.3-0.6 GB per tenant-host - see
  item 4 for the measured seed-run figure this estimate is checked against.
- Backups, point-in-time recovery and the reverse-direction network path
  (Container Apps to the VPS) are now this project's own responsibility;
  none of the three is covered by this ADR and each is an open item for a
  later infra task (see items 6 and 8).
- `applications/viewer` still reads from Azure Blob Storage today; its
migration to this database is Task 5, not part of this ADR.
</content>
