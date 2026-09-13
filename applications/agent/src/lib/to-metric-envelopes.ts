import type { MetricEnvelope, MetricPoint, VpsSample } from '@metrion/shared';

/**
 * Maps one run's measurements onto the generic wire format (ADR 0003).
 *
 * Lives in the collector, not in `@metrion/shared`: this is runtime code, and
 * that package has to erase completely at compile time or the VPS deploy
 * (zero runtime dependencies, no `npm install` on the box) stops working.
 *
 * Takes the collector's in-memory aggregate as-is. `VpsSample` is the exact
 * bundle `main.ts` has in hand at the end of a run, so mapping from it keeps
 * the call site to a single expression.
 */

/** Every point covers the whole minute between systemd timer ticks (`OnCalendar=*-*-* *:*:00`). */
const INTERVAL_SECONDS = 60;

export function toMetricEnvelopes(sample: VpsSample): MetricEnvelope[] {
  const at = sample.timestamp;
  const point = (name: string, value: number, unit: string): MetricPoint => ({
    name,
    value,
    unit,
    intervalSeconds: INTERVAL_SECONDS,
    timestamp: at,
  });

  const hostPoints: MetricPoint[] = [
    point('cpu.usage', sample.cpu.usagePercent, 'percent'),
    point('cpu.load1', sample.cpu.loadAvg1, 'count'),
    point('cpu.load5', sample.cpu.loadAvg5, 'count'),
    point('cpu.load15', sample.cpu.loadAvg15, 'count'),
    point('cpu.vcpus', sample.cpu.vcpus, 'count'),
    point('memory.total', sample.memory.totalMiB, 'MiB'),
    point('memory.used', sample.memory.usedMiB, 'MiB'),
    point('memory.available', sample.memory.availableMiB, 'MiB'),
    point('memory.cached', sample.memory.cachedMiB, 'MiB'),
    point('disk.root.total', sample.disk.root.totalMiB, 'MiB'),
    point('disk.root.used', sample.disk.root.usedMiB, 'MiB'),
    point('disk.root.usedPercent', sample.disk.root.usedPercent, 'percent'),
    point('disk.docker.images', sample.disk.docker.imagesMiB, 'MiB'),
    point('disk.docker.containers', sample.disk.docker.containersMiB, 'MiB'),
    point('disk.docker.volumes', sample.disk.docker.volumesMiB, 'MiB'),
    point('disk.docker.buildCache', sample.disk.docker.buildCacheMiB, 'MiB'),
  ];

  // A null rate emits NO point, never a 0. The first run after a reboot (and
  // any interface counter reset) has nothing to subtract from, and writing a
  // zero there would draw a real-looking trough on the chart for a minute
  // nobody measured. Absent is the truth; the viewer can gap the line.
  if (sample.network.rxBytesPerSec !== null) {
    hostPoints.push(point('network.rx', sample.network.rxBytesPerSec, 'bytes/s'));
  }
  if (sample.network.txBytesPerSec !== null) {
    hostPoints.push(point('network.tx', sample.network.txBytesPerSec, 'bytes/s'));
  }

  const envelopes: MetricEnvelope[] = [{ resource: sample.host, metrics: hostPoints }];

  for (const container of sample.containers) {
    // ponytail: `image` and `status` are dropped - a MetricPoint carries a
    // number, and the envelope has no label/dimension field to put a string
    // in. If the viewer ends up needing the image tag, add `labels?:
    // Readonly<Record<string, string>>` to MetricEnvelope rather than
    // smuggling strings in as metric names.
    envelopes.push({
      resource: sample.host,
      subResource: `container:${container.name}`,
      metrics: [
        point('container.cpu', container.cpuPercent, 'percent'),
        point('container.memory.used', container.memUsedMiB, 'MiB'),
        point('container.memory.limit', container.memLimitMiB, 'MiB'),
        point('container.restarts', container.restartCount, 'count'),
        point('container.oomKilled', container.oomKilled ? 1 : 0, 'bool'),
      ],
    });
  }

  // Keyed by hostname only - no IP, user agent, path or query string reaches
  // an envelope. The status-code breakdown is a per-host count, not per
  // request, so it carries nothing about who asked for what.
  for (const [hostname, stats] of Object.entries(sample.requestsByHost)) {
    const metrics: MetricPoint[] = [
      point('requests.count', stats.count, 'count'),
      point('requests.latency.avg', stats.avgLatencyMs, 'ms'),
    ];
    for (const [status, count] of Object.entries(stats.statusCounts)) {
      metrics.push(point(`requests.status.${status}`, count, 'count'));
    }
    envelopes.push({ resource: sample.host, subResource: `requests:${hostname}`, metrics });
  }

  envelopes.push({
    resource: sample.host,
    subResource: 'collector',
    metrics: [
      point('collector.duration', sample.collector.durationMs, 'ms'),
      point('collector.cpuTime', sample.collector.cpuTimeMs, 'ms'),
      point('collector.maxRss', sample.collector.maxRssMiB, 'MiB'),
      point('collector.queuedSamples', sample.collector.queuedSamples, 'count'),
    ],
  });

  return envelopes;
}
