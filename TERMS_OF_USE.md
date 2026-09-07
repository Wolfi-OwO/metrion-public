# Terms of Use (Nutzungsbedingungen)

**mona — server supervision platform**
Effective: 2026-09-07

Operator: Phillip Kofler, Villach, Kärnten, Österreich — see `IMPRESSUM.md`.

---

## 1. What this covers

Three surfaces are reachable over the internet:

- the **public read API** (`GET /api/v1/resources`, `GET /api/v1/metrics`),
- the **API documentation site** at `/docs` and `/openapi.json`,
- the **authenticated ingest endpoint**, `POST /api/v1/ingest`.

Using any of them means accepting these terms. There is no user account and no
registration; use is the acceptance.

## 2. The read API and documentation

Public and unauthenticated on purpose: it serves aggregate resource usage of
the operator's own machines. It is provided for reading, not as a data feed to
resell or redistribute as your own. Automated polling is fine within the rate
limits; working around them is not.

A **global** rate limit applies to every route, every caller together — it is
not per client, so a burst from one caller can exhaust it for everyone. Over
the limit the answer is `429`. Liveness checks are exempt. Query ranges are
capped at 31 days per request.

## 3. The ingest endpoint

`POST /api/v1/ingest` accepts metrics from senders other than the operator's
own collector.

**Who may send.** Only a holder of a valid `INGEST_TOKEN`, issued by the
operator, presented as `Authorization: Bearer <token>`. There is one shared
token; there are no per-sender tokens and no accounts. No request without a
valid token is accepted, and the service refuses to start without a token
configured, so the endpoint is never open by accident.

**What a token holder is responsible for.** Everything sent under that token,
whatever machine actually sent it. Specifically:

- **Accuracy.** A token holder may append points under any `resource` name,
  including names belonging to the operator's own machines. Nothing in the
  format distinguishes an ingested line from a collected one. Sending
  fabricated, mislabelled or duplicated points corrupts the operator's metrics
  history and is a breach of these terms.
- **Custody of the token.** Keep it out of shell history, logs, screenshots,
  chats and public repositories. Report a suspected leak to
  <koflerphillip@outlook.com> immediately — see `SECURITY.md` for the rotation
  procedure. Until the token is rotated, everything sent with it counts as sent
  by the holder.
- **Content of the payload.** Only numeric measurements about your own systems.
  The schema admits no free-text field, but `resource`, `subResource` and metric
  names are strings within a restricted character set: do not put personal data,
  credentials, secrets or anything you do not have the right to publish into
  them. Ingested data lands in the same storage the **public** read API serves —
  **anything you send is published.**
- **Legality.** Sending data you are not entitled to collect or disclose, or
  using the endpoint to attack, flood or probe the service, is prohibited.

Limits: 200 envelopes per request, 1000 points per envelope, a 256 kB body, a
per-token rate limit, and timestamps within the last 24 hours and not in the
future. A request breaching any of these is rejected with `400`, `413` or `429`.
A rejected request is not stored.

**Withdrawal.** The operator may rotate the token or refuse a sender at any
time, without notice and without giving reasons — for example after abuse, a
suspected leak, or a sender being decommissioned. Rotation invalidates every
existing sender at once; there is exactly one valid token at a time.

## 4. No warranty, no availability promise

mona is provided **as is**. It runs with `minReplicas: 0`, so the first request
after an idle period wakes a container and is slow. There is no uptime
commitment, no support obligation, and maintenance may happen without notice.

Metrics may be missing, delayed, duplicated at a minute boundary, or wrong.
Do not use them as the sole basis for any decision that matters — an alarm, a
capacity purchase, a billing claim. Liability is excluded to the extent
permitted by Austrian law; liability for intent and gross negligence, and under
mandatory statutory provisions, remains unaffected.

## 5. Intellectual property

The source code is **proprietary** — see `LICENSE`. Public visibility of the
repository grants no licence to use, copy, modify or distribute it. Metric data
served by the public API describes the operator's own infrastructure and remains
the operator's.

## 6. Privacy

No cookies, no analytics, no tracking, no third-party requests from the browser,
and no client IP, user agent, request path or query string recorded anywhere in
the pipeline. Details, with the file and line behind each claim, in `PRIVACY.md`.

## 7. Changes

These terms may change. The effective date at the top marks the current version;
continued use after a change is acceptance of it.

## 8. Governing law

Austrian law, excluding its conflict-of-law rules and the UN Convention on
Contracts for the International Sale of Goods. Place of jurisdiction: Austria.
Mandatory consumer protection provisions of a consumer's country of residence
remain unaffected.

## 9. Contact

<koflerphillip@outlook.com>

---

Effective: 2026-09-07
