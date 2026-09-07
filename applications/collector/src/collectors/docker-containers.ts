import type { ContainerSample } from '@mona/shared';
import { dockerGetJson } from '../lib/docker-socket.js';

const MIB = 1024 * 1024;

interface DockerContainerListItem {
  readonly Id: string;
  readonly Names: readonly string[];
  readonly Image: string;
}

interface DockerInspect {
  readonly RestartCount: number;
  readonly State: { readonly Status: string; readonly OOMKilled: boolean };
}

interface DockerStats {
  readonly cpu_stats: {
    readonly cpu_usage: { readonly total_usage: number; readonly percpu_usage?: readonly number[] };
    readonly system_cpu_usage?: number;
    readonly online_cpus?: number;
  };
  readonly precpu_stats: {
    readonly cpu_usage: { readonly total_usage: number };
    readonly system_cpu_usage?: number;
  };
  readonly memory_stats: {
    readonly usage?: number;
    readonly limit?: number;
    readonly stats?: {
      readonly total_inactive_file?: number;
      readonly inactive_file?: number;
      readonly cache?: number;
    };
  };
}

/**
 * Standard Docker CPU% formula (the same one the CLI's `docker stats` uses):
 * how much of the delta in the container's cgroup CPU time was actually
 * used, relative to the delta in the whole system's CPU time, scaled by
 * core count. Returns 0 rather than NaN when `stream=false` hasn't yet
 * produced two distinct samples (system delta of 0).
 */
export function computeCpuPercent(stats: DockerStats): number {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta =
    (stats.cpu_stats.system_cpu_usage ?? 0) - (stats.precpu_stats.system_cpu_usage ?? 0);
  const numCpus =
    stats.cpu_stats.online_cpus ?? stats.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
  if (systemDelta <= 0 || cpuDelta <= 0) return 0;
  return (cpuDelta / systemDelta) * numCpus * 100;
}

/**
 * Same page-cache trap as the host-level memory reading (mem-info.ts):
 * `memory_stats.usage` is the raw cgroup counter and includes reclaimable
 * page cache. Subtracting the inactive-file figure is what `docker stats`
 * itself does to report the honest figure instead - which field that is
 * depends on the cgroup version: `total_inactive_file` on cgroup v1,
 * `inactive_file` on cgroup v2 (confirmed against a real container on
 * this cgroup-v2 host: `cache`/`total_inactive_file` are both absent from
 * `memory_stats.stats` there, only `inactive_file` exists, and using it
 * reproduced `docker stats`'s own 54.32MiB exactly for a container where
 * the naive `usage` alone read 78.68MiB).
 */
export function computeMemUsedMiB(stats: DockerStats): number {
  const usage = stats.memory_stats.usage ?? 0;
  const cacheStats = stats.memory_stats.stats ?? {};
  const cache = cacheStats.total_inactive_file ?? cacheStats.inactive_file ?? cacheStats.cache ?? 0;
  return Math.max(0, usage - cache) / MIB;
}

export async function collectContainerSamples(socketPath: string): Promise<ContainerSample[]> {
  const containers = await dockerGetJson<DockerContainerListItem[]>(socketPath, '/containers/json');

  const samples = await Promise.all(
    containers.map(async (container): Promise<ContainerSample> => {
      const name = container.Names[0]?.replace(/^\//, '') ?? container.Id.slice(0, 12);
      const [inspect, stats] = await Promise.all([
        dockerGetJson<DockerInspect>(socketPath, `/containers/${container.Id}/json`),
        dockerGetJson<DockerStats>(socketPath, `/containers/${container.Id}/stats?stream=false`),
      ]);
      return {
        name,
        image: container.Image,
        status: inspect.State.Status,
        cpuPercent: computeCpuPercent(stats),
        memUsedMiB: computeMemUsedMiB(stats),
        memLimitMiB: (stats.memory_stats.limit ?? 0) / MIB,
        restartCount: inspect.RestartCount,
        oomKilled: inspect.State.OOMKilled,
      };
    }),
  );

  return samples;
}

export interface DockerDiskUsage {
  readonly imagesMiB: number;
  readonly containersMiB: number;
  readonly volumesMiB: number;
  readonly buildCacheMiB: number;
}

interface DockerSystemDf {
  readonly ImageUsage?: { readonly TotalSize?: number };
  readonly ContainerUsage?: { readonly TotalSize?: number };
  readonly VolumeUsage?: { readonly TotalSize?: number };
  readonly BuildCacheUsage?: { readonly TotalSize?: number };
}

/**
 * `docker system df`'s own data source - the slow leak (images/volumes/logs
 * growing unbounded) the brief calls out.
 *
 * Reads the `*Usage.TotalSize` summary fields, not a hand-rolled sum over
 * the per-item `Images`/`Volumes`/`BuildCache` arrays. Measured the
 * difference for images on this machine: summing each image's own `Size`
 * gave 17.74GB while `docker system df` itself reported 13.83GB for the
 * same images - shared base layers (e.g. two images built on the same
 * Node base) get counted once per image in `Size`, so a manual sum
 * double-counts them. `ImageUsage.TotalSize` is the daemon's own
 * already-deduplicated total and is what actually matches the CLI's
 * number (confirmed: Containers/Volumes/BuildCache sums matched their
 * `*Usage.TotalSize` exactly - only images have this gap - but reading
 * the summary field for all four means never having to re-derive that
 * per-category, if a future Docker version changes how any of them dedup).
 */
export async function collectDockerDiskUsage(socketPath: string): Promise<DockerDiskUsage> {
  const df = await dockerGetJson<DockerSystemDf>(socketPath, '/system/df');
  return {
    imagesMiB: (df.ImageUsage?.TotalSize ?? 0) / MIB,
    containersMiB: (df.ContainerUsage?.TotalSize ?? 0) / MIB,
    volumesMiB: (df.VolumeUsage?.TotalSize ?? 0) / MIB,
    buildCacheMiB: (df.BuildCacheUsage?.TotalSize ?? 0) / MIB,
  };
}
