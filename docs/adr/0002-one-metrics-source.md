# ADR 0002: One metrics source for the collector, the overload alarm, and the status page

## Status

Accepted, 2026-09-05.

## Context

Three separate efforts were going to read the same numbers off the VPS: this
collector, a planned systemd-timer overload alarm (CPU/RAM/disk/container
restarts, e-mail + log), and a planned per-app CPU/RAM tile on
`status.woofi-developments.at`. Three measurements of the same thing is
exactly the "two schedulers on one daemon" class of bug called out in the
global CLAUDE.md - not hypothetically; it is how "the graph says 40% but the
alert fired at 90%" bugs get made, because two measurements taken a few
seconds apart, with different honesty about page cache, will disagree.

## Decision

This collector is the one source. The other two consume it, they do not
re-measure:

- **Overload alarm.** Reads the same day-blob (or, once it exists, the
  viewer's API) this collector writes, and fires against the exact numbers
  already computed here - the honest `MemAvailable`-based "used", the same
  cgroup-v2-aware container memory figure, the same net-rate math. It adds
  the threshold/e-mail logic and its own schedule; it does not read
  `/proc/meminfo` a second time.
- **Status page CPU/RAM tiles.** Reads the viewer's API (next project) for
  "this app's current CPU/RAM", not `docker stats` directly from the
  status-page process. The viewer becomes the one thing anything on
  `woofi-developments.at` asks for a live number, and it in turn only ever
  answers from what this collector already measured and shipped to Azure.

## Consequences

- A metric changing its definition (e.g. how container memory is
  cache-adjusted) happens once, here, and every consumer picks it up for
  free instead of three call sites drifting apart.
- Both future consumers depend on this collector's data actually landing in
  Azure on schedule - which is exactly what this project's own delivery
  report verifies (three consecutive minutes, read back from the real
  storage account, not inferred from an exit code).
