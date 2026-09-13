# ADR 0005: The authenticated API key determines tenancy, never the envelope

## Status

Accepted, 2026-09-12.

## Context

ADR 0003's `MetricEnvelope` carries a `resource` field: "who is reporting."
That field is sender-controlled - it is written by whatever process calls
the ingest endpoint, over a wire format the schema deliberately does not
constrain (ADR 0003's own stated price: "nothing stops a sender writing
`cpu.usage` in `MiB`. The unit travels with the point rather than being
enforced by the schema"). The same is true of `resource`: any caller that
holds a valid credential can put any string there.

Once storage is multi-tenant (ADR 0004), something has to decide which
`project_id` a row belongs to. Using `resource` for that would mean trusting
a value the sender wrote, to answer the one question access control exists
to get right - which account this data belongs to. A sender could write
`resource: "someone-elses-host"` and, if `resource` were the tenancy key,
have their write attributed to whatever account they typed, not the account
their credential actually belongs to.

## Decision

Tenancy is resolved once, at authentication, from the API key - not from
anything in the request body. `api_keys.project_id` (Task 3 schema) is the
only path from a request to a `project_id`: the ingest endpoint (Task 4)
looks up the presented key, resolves it to exactly one project, and writes
that `project_id` into every row the request produces. `resource` keeps its
ADR 0003 meaning - which part of that project's infrastructure a point
describes - and never determines which project a row is scoped to.

## Consequences

- A sender cannot write into another account's data by choosing what to put
  in `resource`, because `resource` is never read as a tenancy claim.
- One API key resolves to exactly one project; a sender reporting for
  multiple projects needs one key per project, not one key with a
  project-selecting field in the body.
- Revoking access is revoking a key (`api_keys.revoked_at`, Task 3), not
auditing every envelope a sender has ever written for a stray
`resource` value.
</content>
