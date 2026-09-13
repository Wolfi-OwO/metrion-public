import fs from 'node:fs';

const KIB_PER_MIB = 1024;

/**
 * Parses `/proc/meminfo` into the raw kB fields we need. Exported separately
 * from {@link readMemInfo} so the self-check can feed it a fixture string
 * instead of the real `/proc/meminfo`.
 */
export function parseMemInfo(text: string): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const line of text.split('\n')) {
    // Format: "MemTotal:        8130584 kB"
    const match = /^(\w+):\s+(\d+)\s*kB$/.exec(line);
    if (match?.[1] && match[2]) {
      fields[match[1]] = Number(match[2]);
    }
  }
  return fields;
}

export interface MemInfo {
  readonly totalMiB: number;
  readonly usedMiB: number;
  readonly availableMiB: number;
  readonly cachedMiB: number;
}

/**
 * "Used" here is `MemTotal - MemAvailable`, never `MemTotal - MemFree`.
 * `free`'s naive used-memory figure double-counts reclaimable page cache as
 * "used" - the exact trap the global CLAUDE.md notes for `hypr-memreport`
 * on the desktop side (there it's RSS double-counting shared pages across
 * processes; here it's the same mistake one level up, at the whole-host
 * level). `MemAvailable` is the kernel's own estimate of what a new
 * allocation could actually get without swapping, so `MemTotal -
 * MemAvailable` is the honest "used" figure.
 */
export function toMemInfo(fields: Record<string, number>): MemInfo {
  const totalKb = fields.MemTotal ?? 0;
  const availableKb = fields.MemAvailable ?? 0;
  const cachedKb = (fields.Cached ?? 0) + (fields.SReclaimable ?? 0);
  return {
    totalMiB: totalKb / KIB_PER_MIB,
    usedMiB: (totalKb - availableKb) / KIB_PER_MIB,
    availableMiB: availableKb / KIB_PER_MIB,
    cachedMiB: cachedKb / KIB_PER_MIB,
  };
}

export function readMemInfo(): MemInfo {
  const text = fs.readFileSync('/proc/meminfo', 'utf8');
  return toMemInfo(parseMemInfo(text));
}
