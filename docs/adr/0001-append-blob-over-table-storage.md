# ADR 0001: Append Blob over Table Storage for minute samples

## Status

Accepted, 2026-09-05.

## Context

The collector writes one JSON sample per minute. Over months that's
hundreds of thousands of rows - "minute values summed over months," per the
brief. Two real Azure options were on the table: Azure Table Storage
(partition key = day, row key = timestamp) or an Append Blob (one per UTC
day, newline-delimited JSON).

Table Storage's advantage would be server-side range queries ("give me
14:00-14:05 today") without downloading a whole day. Its real cost here:
**no built-in TTL/retention.** Classic Azure Table Storage (not the Cosmos
DB Table API) has no automatic expiry - keeping "minute values don't grow
unbounded" would mean a second scheduled job whose only purpose is walking
old partitions and deleting them. That is a second thing to build, deploy,
and monitor for the one property retention is supposed to provide for free.

## Decision

Append Blob, one per UTC day (`<container>/<YYYY-MM-DD>.jsonl`), retention
via a **Blob Lifecycle Management policy** (`vps-metrics-retention-90d` on
the storage account) that deletes blobs 90 days after their last write - a
day-blob's last write is its last minute of that UTC day, so this is
"delete anything older than ~90 days," done entirely by the storage
platform, zero code.

Querying: a day's blob is ~1440 lines, a few hundred KB. The (future)
viewer downloads the day(s) it needs and filters in memory - trivially
cheap at this data volume, and it is the one machine on the other end of
this pipeline, not a multi-tenant query workload that would justify Table
Storage's indexing.

## Consequences

- Write path is one `Append Block` REST call per minute - cheaper than a
  Table Storage insert transaction at this frequency, and needs no SDK
  (implemented directly over HTTPS with a SAS token - see the collector's
  `azure/append-blob-client.ts`).
- Reading "just the last 5 minutes" means downloading the current day's
  blob and filtering, not a targeted range query. Acceptable at one VPS's
  worth of data; would need reconsidering if this ever collects from many
  hosts into one container.
- Retention is a platform policy, not application code - nothing to keep
  in sync with a second job.
