import fs from 'node:fs';

const MIB = 1024 * 1024;

export interface RootDiskUsage {
  readonly totalMiB: number;
  readonly usedMiB: number;
  readonly usedPercent: number;
}

/**
 * `fs.statfsSync` (stable since Node 18.15) reads the same statvfs data
 * `df` does, without spawning a `df` process every minute - stdlib covers
 * it, no subprocess needed.
 *
 * `usedPercent` deliberately matches `df`'s own formula, not the naive
 * `used / total`: measured against this box's real root filesystem,
 * `df -h /` reported 58% while `used / total` computed 54.6% - a real,
 * reproducible ~4-point gap, not rounding noise. `df` excludes the
 * filesystem's root-reserved blocks (ext4 reserves ~5% for root by
 * default) from the denominator, i.e. `used / (used + bavail)`, where
 * `bavail` is space available to an unprivileged user - not `bfree`, which
 * still counts the reserved blocks. Matching that formula is what makes
 * this field comparable to what `df -h /` actually prints.
 */
export function readRootDiskUsage(path = '/'): RootDiskUsage {
  const stats = fs.statfsSync(path);
  const totalBytes = stats.blocks * stats.bsize;
  const freeBytes = stats.bfree * stats.bsize;
  const availableToUserBytes = stats.bavail * stats.bsize;
  const usedBytes = totalBytes - freeBytes;
  const usedPlusAvailable = usedBytes + availableToUserBytes;
  return {
    totalMiB: totalBytes / MIB,
    usedMiB: usedBytes / MIB,
    usedPercent: usedPlusAvailable > 0 ? (usedBytes / usedPlusAvailable) * 100 : 0,
  };
}
