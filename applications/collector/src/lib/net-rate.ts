import fs from 'node:fs';
import { findDefaultRouteInterface } from './default-net-iface.js';
import { readJsonState, writeJsonState } from './state-store.js';

export interface NetCounters {
  readonly rxBytes: number;
  readonly txBytes: number;
}

interface StoredNetSample extends NetCounters {
  readonly atMs: number;
}

/**
 * Reads rx/tx bytes for exactly one named interface out of `/proc/net/dev`.
 *
 * Deliberately NOT a sum over every interface except `lo`: this box also
 * has `docker0`/`br-*`/`veth*` interfaces that Docker creates and destroys
 * per container network attach/detach - summing them double-counts
 * container-to-container traffic (every such packet is both an rx and a
 * tx on some bridge/veth) and, worse, makes the total look like it went
 * BACKWARDS whenever one of those ephemeral interfaces disappears between
 * two samples (reproduced live: a Caddy container restart during
 * development recreated its veth pair and the summed counter dropped,
 * which `computeNetRate` then - correctly, given the input - reported as
 * a reset). Reading only the box's real uplink avoids all of that and
 * matches what "network speed" means in the brief: traffic to/from the
 * internet, not internal container plumbing.
 */
export function readInterfaceCounters(text: string, iface: string): NetCounters {
  for (const line of text.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    if (line.slice(0, colonIndex).trim() !== iface) continue;
    const fields = line
      .slice(colonIndex + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    // /proc/net/dev columns: rx: bytes packets errs drop fifo frame compressed multicast, then tx: bytes ...
    return { rxBytes: fields[0] ?? 0, txBytes: fields[8] ?? 0 };
  }
  return { rxBytes: 0, txBytes: 0 };
}

/**
 * Determines the interface once via the default route, falling back to
 * `eth0` (the common case, and this box's actual interface name) only if
 * `/proc/net/route` has no default route line to read - e.g. right at
 * boot before routing is up. ponytail: no interface-hotplug handling
 * beyond that - a renamed/replaced NIC would need a restart to pick up.
 */
export function readProcNetDev(): NetCounters {
  const iface = findDefaultRouteInterface() ?? 'eth0';
  return readInterfaceCounters(fs.readFileSync('/proc/net/dev', 'utf8'), iface);
}

export interface NetRate {
  readonly rxBytesPerSec: number | null;
  readonly txBytesPerSec: number | null;
}

/**
 * The counters in `/proc/net/dev` are cumulative since boot, not a rate -
 * this is the delta-over-time the brief asks for. Two cases return `null`
 * instead of a number:
 *
 *  - first ever run (no prior sample to diff against)
 *  - either counter went DOWN since the last sample - only possible if the
 *    interface (or the whole host) restarted and the counter reset to
 *    (near) zero. Reporting a negative or a huge rate here would be a
 *    hypothesis pretending to be a measurement; `null` says "unknown for
 *    this minute" instead, and the next minute's diff is valid again.
 *
 * 64-bit overflow of the counters themselves is not handled: modern kernels
 * expose /proc/net/dev in 64-bit words, so an overflow would take centuries
 * at any realistic link speed - not a real ceiling on this box.
 */
export function computeNetRate(
  current: NetCounters,
  previous: StoredNetSample | undefined,
  nowMs: number,
): NetRate {
  if (!previous) {
    return { rxBytesPerSec: null, txBytesPerSec: null };
  }
  const deltaSeconds = (nowMs - previous.atMs) / 1000;
  if (
    deltaSeconds <= 0 ||
    current.rxBytes < previous.rxBytes ||
    current.txBytes < previous.txBytes
  ) {
    return { rxBytesPerSec: null, txBytesPerSec: null };
  }
  return {
    rxBytesPerSec: (current.rxBytes - previous.rxBytes) / deltaSeconds,
    txBytesPerSec: (current.txBytes - previous.txBytes) / deltaSeconds,
  };
}

/** Reads the current counters, diffs against the persisted last sample, then persists the new one. */
export function measureNetRate(statePath: string): NetRate {
  const current = readProcNetDev();
  const nowMs = Date.now();
  const previous = readJsonState<StoredNetSample>(statePath);
  const rate = computeNetRate(current, previous, nowMs);
  writeJsonState(statePath, { ...current, atMs: nowMs } satisfies StoredNetSample);
  return rate;
}
