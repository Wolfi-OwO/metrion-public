import path from 'node:path';
import type { CpuSample, DiskSample, MemorySample, NetworkSample } from '@vps-metrics/shared';
import { countVcpus, measureCpuUsagePercent, readLoadAverage } from '../lib/cpu-usage.js';
import { readRootDiskUsage } from '../lib/disk-usage.js';
import { readMemInfo } from '../lib/mem-info.js';
import { measureNetRate } from '../lib/net-rate.js';
import { collectDockerDiskUsage } from './docker-containers.js';

export interface SystemSample {
  readonly cpu: CpuSample;
  readonly memory: MemorySample;
  readonly disk: DiskSample;
  readonly network: NetworkSample;
}

const EMPTY_DOCKER_DISK = { imagesMiB: 0, containersMiB: 0, volumesMiB: 0, buildCacheMiB: 0 };

export async function collectSystemSample(
  stateDir: string,
  dockerSocketPath: string,
): Promise<SystemSample> {
  // Only the Docker disk-usage half of this can plausibly fail on its own
  // (Docker socket briefly unreachable) - cpu/mem/root-disk/net all read
  // /proc or the local filesystem directly and failing there means
  // something is fundamentally wrong, worth letting bubble up rather than
  // silently zeroing the host's own vitals.
  const [usagePercent, dockerDisk] = await Promise.all([
    measureCpuUsagePercent(),
    collectDockerDiskUsage(dockerSocketPath).catch((error: unknown) => {
      console.error(
        `Docker disk usage collection failed, reporting zero for this minute: ${(error as Error).message}`,
      );
      return EMPTY_DOCKER_DISK;
    }),
  ]);
  const [loadAvg1, loadAvg5, loadAvg15] = readLoadAverage();
  const mem = readMemInfo();
  const root = readRootDiskUsage('/');
  const net = measureNetRate(path.join(stateDir, 'net-counters.json'));

  return {
    cpu: { usagePercent, loadAvg1, loadAvg5, loadAvg15, vcpus: countVcpus() },
    memory: mem,
    disk: { root, docker: dockerDisk },
    network: net,
  };
}
