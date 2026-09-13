# Security Policy

`metrion` collects minute-by-minute resource metrics from my own VPS and serves
them back as charts. Two things run: the **collector** on the VPS, which
appends one JSON line a minute straight to Azure Blob Storage, and the
**viewer**, an Azure Container App that reads those blobs back and exposes a
public read API plus one authenticated write endpoint.

## Reporting a vulnerability

Report privately rather than opening a public issue:

- Contact: koflerphillip@outlook.com

Do not put a real SAS token, ingest token, storage account name or the VPS's
own address in the report; describe the flaw and share reproduction details
over a private channel.

### Scope

- Source code and CI/CD configuration in this repository.
- Not in scope: Azure Storage itself, Docker, or the VPS's OS - report those
  upstream.

## What this pipeline deliberately does not collect

No client IPs, no user agents, no request paths, no query strings. Not in a
blob, not in a log line, not in an API response, not in an error body.

Caddy's access log is read for hostname, status code and latency only,
aggregated per minute - `applications/agent/src/collectors/caddy-requests.ts`
enforces this by its type simply not naming `remote_ip`, `request.headers` or
`request.uri`, rather than by a filter that could miss one.

`pino-http`'s default request serializer emits `remoteAddress`, `remotePort`
and the full header set, and puts the query string in `url`. The viewer
replaces that serializer outright (`applications/viewer/src/main.ts`) rather
than trimming it, so a future field added upstream cannot reintroduce the
capture. A log line from the viewer contains exactly `method`, `path`,
`statusCode` and `responseTime`.

The one deliberate exception is `path`: the viewer's own route, e.g.
`/api/v1/metrics`. It is the app's own URL space, carries nothing about who
asked, and without it a 500 cannot be traced to an endpoint.

## The ingest token

`POST /api/v1/ingest` is the only authenticated endpoint. The read endpoints
are public by decision: they serve aggregate resource usage of my own machines,
which is the same class of data a public status page already shows.

**Model**

- One shared bearer token, `INGEST_TOKEN`, presented as
  `Authorization: Bearer <token>`. There are no per-sender tokens and no user
  accounts - the only client is a machine.
- **Required at boot.** The viewer refuses to start without it, so a
  misconfigured deploy cannot come up with an unauthenticated write endpoint
  appending to the same blobs the collector writes.
- Compared by SHA-256 digest with `crypto.timingSafeEqual`
  (`src/middlewares/auth.ts`). Digests rather than raw buffers on purpose:
  `timingSafeEqual` throws on unequal lengths and a length pre-check would leak
  the token's length through that branch, while two 32-byte digests are equal
  length by construction.
- Rate limited per token, keyed on a **SHA-256 hash** of it, so the limiter's
  in-memory store never holds the secret.
- Never logged, never echoed in an error, never present in `/openapi.json` -
  the spec documents only that a bearer scheme exists.
- The collector does **not** hold this token. It writes to blob storage
  directly with a container-scoped SAS restricted to `ac` (add + create):
  no read, no list, no delete.
- The viewer holds no storage secret at all. It authenticates to Azure with a
  system-assigned managed identity, via an explicit
  `ChainedTokenCredential(ManagedIdentityCredential, AzureCliCredential)`
  rather than `DefaultAzureCredential` - whose chain begins with
  `EnvironmentCredential`, so an `AZURE_CLIENT_SECRET` in the environment would
  silently switch the app onto a long-lived client secret with nothing to show
  that it had.

**What holding the token gets an attacker.** It is a write credential for the
metrics history: they can append fabricated points under any `resource` name,
including the real VPS's, and so poison the charts. It grants no read access
that the public API does not already give, and no access to the storage account
beyond appending to the current UTC day-blob. Treat a leaked ingest token as
corrupted history, not as disclosure.

### Rotating the ingest token

Generate, deploy, verify, retire. The viewer accepts exactly one token at a
time, so senders must be updated in the same window.

```bash
# 1. Generate. 32 bytes of hex - do not reuse a password manager entry.
NEW_TOKEN=$(openssl rand -hex 32)

# 2. Set it on the container app. Store as a SECRET, then reference it, so the
#    value never appears in the revision's plaintext env block.
az containerapp secret set \
  --name <app> --resource-group <rg> \
  --secrets ingest-token="$NEW_TOKEN"

az containerapp update \
  --name <app> --resource-group <rg> \
  --set-env-vars INGEST_TOKEN=secretref:ingest-token
```

Updating the env var creates a new revision. With `minReplicas: 0` there may be
no replica running; the next request starts one on the new revision.

```bash
# 3. Verify the new token works and the old one does not.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<app>/api/v1/ingest \
  -H "Authorization: Bearer $NEW_TOKEN" -H 'Content-Type: application/json' \
  -d '{"resource":"rotation-check","metrics":[{"name":"cpu.usage","value":0,"unit":"percent","intervalSeconds":60,"timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}]}'
# expect 202

curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<app>/api/v1/ingest \
  -H "Authorization: Bearer $OLD_TOKEN" -d '{}'
# expect 401 - if this is 202 the old revision is still serving traffic
```

```bash
# 4. Update every sender that posts to /api/v1/ingest. The collector is NOT one
#    of them - it holds a SAS, not this token - so nothing on the VPS changes.

# 5. Retire the old secret value once no sender uses it.
az containerapp revision list --name <app> --resource-group <rg> -o table
```

Rotate when: a token appears in a shell history, a log, a screenshot or a chat;
a sender that held it is decommissioned; or on a schedule of 12 months,
whichever is first. **Rotate first, then clean up** - a token that was pasted
somewhere public is burned the moment it lands, and deleting the message does
not unburn it.

### Rotating the collector's SAS token

Separate credential, separate procedure - see
`organizational/deployment-runbook.md`. It lives in
`/etc/vps-metrics-collector/collector.env` (mode 600) on the VPS and is scoped
to `ac` on the container. Reissue it from the storage account, replace the file,
and run the unit once by hand to confirm before trusting the timer.

## Limits that exist for cost, not just abuse

The viewer runs at `minReplicas: 0, maxReplicas: 1`. Traffic costs money twice:
it keeps a replica warm, and each read request fans out to up to 31 blob reads.

- A **global** rate limit covers every route (`GLOBAL_RATE_LIMIT_MAX`,
  default 300/minute), including unauthenticated 401s and the public read API.
  It is global rather than per-client because there is no client identity here
  to key on - reading a client IP is exactly what the privacy rules exclude.
  Liveness is exempt so a rate limit cannot restart a healthy container.
- A **per-token** limit on `/api/v1/ingest` (`INGEST_RATE_LIMIT_MAX`,
  default 120/minute), mounted after the auth check so an invalid token cannot
  create a bucket.
- Query ranges are capped at 31 days, day-blobs are read one at a time, and no
  single day-blob is buffered past 64 MiB.
