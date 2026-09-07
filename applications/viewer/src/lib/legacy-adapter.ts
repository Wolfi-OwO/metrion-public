import type { LegacyMetricsSample, MetricEnvelope, MetricPoint } from '@mona/shared';

/**
 * Reads one line of a day-blob, whichever shape it is.
 *
 * A cutover-day blob holds both: the minutes written before the collector
 * switched to `MetricEnvelope[]` are single legacy objects, the ones after are
 * JSON arrays of envelopes (ADR 0003). Detection is per line, never per blob,
 * for exactly that reason.
 *
 * ponytail: the legacy mapping below is a second copy of
 * `applications/collector/src/lib/to-metric-envelopes.ts`. It cannot be shared
 * - `@mona/shared` must erase completely at compile time or the collector's
 * dependency-free VPS deploy breaks, so runtime code cannot live there. The
 * ceiling is drift: if the collector renames a metric, a chart spanning the
 * cutover silently splits into two series. `tests/legacy-adapter.test.ts`
 * pins the names and units. Delete this file entirely once the ADR 0001
 * 90-day retention has aged out every pre-cutover blob.
 */

/** Same as the collector's: every point covers the minute between timer ticks. */
const INTERVAL_SECONDS = 60;

function isLegacySample(value: object): value is LegacyMetricsSample {
  // `cpu` is the discriminator the ADR names. Checked structurally rather than
  // trusted, since a blob line is the one thing here that is not freshly built
  // in this process.
  return 'cpu' in value && 'timestamp' in value && typeof value.timestamp === 'string';
}

function legacyToEnvelopes(sample: LegacyMetricsSample): MetricEnvelope[] {
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

  // A null rate emitted no point at the collector and synthesises none here.
  // Inventing a 0 for a minute that was never measured would draw a trough on
  // the chart that never happened - and it would be this adapter, not the
  // data, that put it there.
  if (sample.network.rxBytesPerSec !== null) {
    hostPoints.push(point('network.rx', sample.network.rxBytesPerSec, 'bytes/s'));
  }
  if (sample.network.txBytesPerSec !== null) {
    hostPoints.push(point('network.tx', sample.network.txBytesPerSec, 'bytes/s'));
  }

  const envelopes: MetricEnvelope[] = [{ resource: sample.host, metrics: hostPoints }];

  for (const container of sample.containers) {
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

  // Hostname only. The legacy sample never held an IP, a user agent, a path or
  // a query string, and nothing here may invent one.
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

function isValidEnvelope(value: unknown): value is MetricEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { resource?: unknown; metrics?: unknown };
  return typeof candidate.resource === 'string' && Array.isArray(candidate.metrics);
}

/**
 * One blob line to envelopes. Returns `[]` for anything unreadable rather
 * than throwing - the same "corrupt lines are dropped, not fatal to the rest"
 * policy `SampleQueue.readAll` already uses on the collector side. One bad
 * line in a 1440-line day must not cost the other 1439.
 */
export function parseLine(line: string): MetricEnvelope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }

  if (Array.isArray(parsed)) {
    return parsed.every(isValidEnvelope) ? (parsed as MetricEnvelope[]) : [];
  }

  if (typeof parsed === 'object' && parsed !== null && isLegacySample(parsed)) {
    try {
      return legacyToEnvelopes(parsed);
    } catch {
      // A truncated legacy object (a half-written append) reaches a missing
      // nested field only here, not at the shape check above.
      return [];
    }
  }

  return [];
}

/** Parses many lines, reporting how many were unreadable instead of hiding it. */
export function parseLines(lines: readonly string[]): {
  envelopes: MetricEnvelope[];
  skipped: number;
} {
  const envelopes: MetricEnvelope[] = [];
  let skipped = 0;

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const parsedEnvelopes = parseLine(line);
    if (parsedEnvelopes.length === 0) {
      skipped += 1;
      continue;
    }
    envelopes.push(...parsedEnvelopes);
  }

  return { envelopes, skipped };
}
