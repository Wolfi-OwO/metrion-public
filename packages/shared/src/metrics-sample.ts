/**
 * The one wire format the collector writes and the (future) viewer reads.
 *
 * Deliberately excludes anything the privacy review flagged: no client IPs,
 * no user agents, no request paths/query strings. `requestsByHost` is an
 * aggregate over the whole minute, keyed by hostname only.
 *
 * One line of this shape, serialized as JSON, is appended to
 * `<container>/<YYYY-MM-DD>.jsonl` (UTC day) in Azure Blob Storage.
 */
export interface MetricsSample {
  /** ISO-8601 UTC timestamp, truncated to the minute the sample describes. */
  readonly timestamp: string;
  /** `os.hostname()` of the machine that collected this sample. */
  readonly host: string;
  readonly cpu: CpuSample;
  readonly memory: MemorySample;
  readonly disk: DiskSample;
  /** `null` when no rate could be computed yet (first run, or a counter reset - see NetworkSample). */
  readonly network: NetworkSample;
  readonly containers: readonly ContainerSample[];
  /** Aggregated per hostname, from Caddy's access log. Empty if nothing came in that minute. */
  readonly requestsByHost: Readonly<Record<string, HostRequestStats>>;
  /** The collector's own footprint for this run - see "Own footprint" in the delivery report. */
  readonly collector: CollectorSelfSample;
}

export interface CpuSample {
  /** 0-100, instantaneous, measured over a short (~200ms) /proc/stat sampling window. */
  readonly usagePercent: number;
  readonly loadAvg1: number;
  readonly loadAvg5: number;
  readonly loadAvg15: number;
  readonly vcpus: number;
}

export interface MemorySample {
  readonly totalMiB: number;
  /**
   * `MemTotal - MemAvailable` from /proc/meminfo - NOT `MemTotal - MemFree`.
   * The latter counts reclaimable page cache as "used", which is the classic
   * `free` double-counting trap; MemAvailable already accounts for what the
   * kernel could actually reclaim under pressure.
   */
  readonly usedMiB: number;
  readonly availableMiB: number;
  readonly cachedMiB: number;
}

export interface DiskSample {
  readonly root: {
    readonly totalMiB: number;
    readonly usedMiB: number;
    readonly usedPercent: number;
  };
  /** From the Docker Engine `/system/df` endpoint - the slow leak the constraint calls out. */
  readonly docker: {
    readonly imagesMiB: number;
    readonly containersMiB: number;
    readonly volumesMiB: number;
    readonly buildCacheMiB: number;
  };
}

export interface NetworkSample {
  /** `null` on the very first run, or right after a counter reset/rollback (interface restart). */
  readonly rxBytesPerSec: number | null;
  readonly txBytesPerSec: number | null;
}

export interface ContainerSample {
  readonly name: string;
  readonly image: string;
  readonly status: string;
  readonly cpuPercent: number;
  readonly memUsedMiB: number;
  /**
   * The cgroup memory limit Docker reports - confirmed against the real
   * VPS that every running container there already has an explicit
   * `mem_limit` set (128-512MiB range, not host total), so this is a real
   * ceiling to watch, not host memory in disguise. Falls back to total
   * host memory only for a container with no limit set at all.
   */
  readonly memLimitMiB: number;
  /** Cumulative since container creation, not since this sample - a rising number over days is the signal. */
  readonly restartCount: number;
  readonly oomKilled: boolean;
}

export interface HostRequestStats {
  readonly count: number;
  /** Exact status code -> count for that host in this minute, e.g. `{"200": 41, "404": 2}`. */
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly avgLatencyMs: number;
}

export interface CollectorSelfSample {
  readonly durationMs: number;
  /** `process.cpuUsage()` delta (user+system), converted from microseconds. The actual CPU cost, not wall time - most of `durationMs` is waiting on the Docker API/network, not burning CPU. */
  readonly cpuTimeMs: number;
  readonly maxRssMiB: number;
  readonly queuedSamples: number;
}
