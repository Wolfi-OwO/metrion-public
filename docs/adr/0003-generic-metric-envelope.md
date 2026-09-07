# ADR 0003: A generic metric envelope instead of a fixed VPS sample

## Status

Accepted, 2026-09-06.

## Context

The first wire format, `MetricsSample`, hard-coded one machine's anatomy:
`cpu`, `memory`, `disk`, `network`, `containers`, `requestsByHost`,
`collector`. That was right when there was exactly one sender and one thing
to watch. It stops being right the moment a second kind of sender exists -
every new measurement means changing the shared type, the collector and the
viewer together, and every sender that does not have a `cpu` still has to
pretend it does.

The replacement is `MetricEnvelope`: a `resource` (who is reporting), an
optional `subResource` (which part of it), and a flat `metrics[]` of
`{name, value, unit, intervalSeconds, timestamp}`. The schema no longer
knows what a container or a request is; the sender names its own metrics.

Three decisions inside that were not obvious.

## Decision

### English field names, not the draft's

The draft sketched `einheit` and `timestampe`. The fields are `unit` and
`timestamp`. The first is German in an otherwise English codebase, the
second is a typo, and a wire format is the worst possible place to keep
either - it is the one name that ends up copied into every consumer,
every stored blob line and every future query, and it cannot be corrected
later without another cutover exactly like this one.

### One JSONL line is a JSON _array_ of envelopes

Not one envelope per line. A single minute produces one host envelope, one
per container, one per request hostname and one for the collector itself -
a dozen or more.

`SampleQueue` is strictly newline-delimited and `flushQueue` derives the
day-blob name from parsing a line, then makes exactly one Azure
`Append Block` call per line. One envelope per line would multiply that
into one HTTPS PUT per container per minute against a live blob, for no
gain. An array keeps one write per minute, and keeps `queue.ts` and
`append-blob-client.ts` untouched.

### Old blobs are never rewritten

The viewer detects the shape per line: `Array.isArray(parsed)` is the new
format, an object with a `cpu` key is the legacy one. `LegacyMetricsSample`
stays in `@mona/shared` purely to type that second branch.

Per line, not per blob, because the blob for the cutover day contains both
shapes - the minutes before the deploy and the minutes after it, in one
file. And no rewrite, because rewriting real history in a live container to
gain nothing but uniformity is precisely the avoidable risk ADR 0001 chose
the storage platform to keep away from.

## Consequences

- A new sender needs no change to `@mona/shared` at all - it names its own
  metrics and the viewer renders whatever arrives.
- The viewer carries two read paths forever, or at least until the 90-day
  lifecycle policy from ADR 0001 has aged out every pre-cutover blob. After
  that `legacy-metrics-sample.ts` can simply be deleted.
- Field names are no longer self-describing at the type level: nothing stops
  a sender writing `cpu.usage` in `MiB`. The unit travels with the point
  rather than being enforced by the schema, which is the price of not having
  the schema know every sender in advance.
