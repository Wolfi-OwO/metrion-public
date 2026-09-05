# Security Policy

This is a private repository holding a metrics collector for one of my
own VPS boxes. If you have access to this repo and find a vulnerability
(credential handling, a way to make the collector run as more than it
needs, an injection path in the Caddy-log parsing, etc.), please report it
privately rather than opening a public issue:

- Contact: koflerphillip@outlook.com

Do not include real SAS tokens, storage account names, or the VPS's own
address in a report; describe the flaw and, if needed, share reproduction
details over a private channel.

## Scope

- Source code and CI/CD configuration in this repository.
- Not in scope: Azure Storage itself, Docker, or the VPS's OS (report
  those upstream).

## What this collector deliberately does not read

No client IPs, no user agents, no request paths/query strings from
Caddy's access log - only hostname, status code and latency, aggregated
per minute. See `docs/adr/` and the delivery report for the reasoning.
