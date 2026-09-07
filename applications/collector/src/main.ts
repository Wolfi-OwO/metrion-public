import { fileURLToPath } from 'node:url';
import type { LegacyMetricsSample, MetricEnvelope } from '@mona/shared';
import { appendLine, dayBlobName } from './azure/append-blob-client.js';
import { collectHostRequestStats } from './collectors/caddy-requests.js';
import { collectContainerSamples } from './collectors/docker-containers.js';
import { collectSystemSample } from './collectors/system.js';
import { config } from './config/index.js';
import { SampleQueue } from './lib/queue.js';
import { toMetricEnvelopes } from './lib/to-metric-envelopes.js';

/**
 * One run: collect everything, map it to `MetricEnvelope[]` (one JSONL line
 * per run, see ADR 0003), then flush the local queue (this new line
 * included) to Azure oldest-first. No `.listen()` in this app - it is a
 * systemd-timer one-shot, not an HTTP service - so this is the whole
 * "startup file", run directly by the timer's ExecStart.
 * Pure collection/aggregation logic lives in `collectors/`/`lib/` and is
 * importable (and imported, by the tests) without triggering any of this.
 */
export async function collectAndSend(): Promise<{
  sample: LegacyMetricsSample;
  queuedAfter: number;
}> {
  const startedAt = process.hrtime.bigint();
  const cpuUsageAtStart = process.cpuUsage();
  const queue = new SampleQueue(config.stateDir, config.queue.maxLines);

  // Each collector degrades independently: a container list/stats hiccup or
  // a momentarily-restarting Caddy container (observed for real during
  // development) must not throw away the CPU/RAM/disk/network numbers that
  // DID succeed this minute - losing a fully-collectible sample over one
  // unrelated failure would be strictly worse than shipping it with an
  // empty `containers`/`requestsByHost`.
  const [system, containers, requestsByHost] = await Promise.all([
    collectSystemSample(config.stateDir, config.docker.socketPath),
    collectContainerSamples(config.docker.socketPath).catch((error: unknown) => {
      console.error(
        `Container metrics collection failed, reporting none for this minute: ${(error as Error).message}`,
      );
      return [];
    }),
    collectHostRequestStats(
      config.docker.socketPath,
      config.docker.caddyContainerName,
      `${config.stateDir}/caddy-log-cursor.json`,
    ).catch((error: unknown) => {
      console.error(
        `Caddy request-log collection failed, reporting none for this minute: ${(error as Error).message}`,
      );
      return {};
    }),
  ]);

  const timestamp = new Date();
  timestamp.setUTCSeconds(0, 0);

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const cpuUsageDelta = process.cpuUsage(cpuUsageAtStart);
  const cpuTimeMs = (cpuUsageDelta.user + cpuUsageDelta.system) / 1000;
  const maxRssMiB = process.resourceUsage().maxRSS / 1024;

  const sample: LegacyMetricsSample = {
    timestamp: timestamp.toISOString(),
    host: config.host,
    cpu: system.cpu,
    memory: system.memory,
    disk: system.disk,
    network: system.network,
    containers,
    requestsByHost,
    collector: { durationMs, cpuTimeMs, maxRssMiB, queuedSamples: queue.size },
  };

  if (config.dryRun) {
    process.stdout.write(`${JSON.stringify(toMetricEnvelopes(sample))}\n`);
    return { sample, queuedAfter: 0 };
  }

  queue.push(JSON.stringify(toMetricEnvelopes(sample)));
  await flushQueue(queue);
  return { sample, queuedAfter: queue.size };
}

/**
 * The UTC day a queued line belongs in. Handles both shapes on purpose: a
 * line written after the ADR 0003 cutover is an array of envelopes, but the
 * queue file on the live box can still hold pre-cutover object lines at the
 * moment the new build is deployed, and those are real undelivered samples.
 * Returns `null` for anything unparseable rather than throwing.
 */
function lineTimestamp(line: string): Date | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const iso = Array.isArray(parsed)
    ? (parsed as MetricEnvelope[])[0]?.metrics[0]?.timestamp
    : (parsed as LegacyMetricsSample).timestamp;

  if (typeof iso !== 'string') return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Sends every queued line, oldest first, stopping at the first failure so
 * order is preserved and a down Azure doesn't get hammered once per queued
 * line every run. `flushBudgetMs` bounds how long one run can spend on
 * this so a slow/degraded Azure never eats into the next minute's timer.
 */
async function flushQueue(queue: SampleQueue): Promise<void> {
  const budgetEndsAt = Date.now() + config.queue.flushBudgetMs;
  const lines = queue.readAll();
  let sentCount = 0;

  for (const line of lines) {
    if (Date.now() >= budgetEndsAt) break;
    const timestamp = lineTimestamp(line);
    if (timestamp === null) {
      // Dropped, not fatal - same policy as `SampleQueue.readAll`. Throwing
      // here would abort the flush before `replaceAll` runs, so one bad line
      // would wedge the queue permanently and nothing would ever be
      // delivered again.
      console.error('Dropping a queued line with no usable timestamp.');
      sentCount += 1;
      continue;
    }
    const blobName = dayBlobName(timestamp);
    try {
      await appendLine(
        {
          storageAccount: config.azure.storageAccount,
          container: config.azure.container,
          sasToken: config.azure.sasToken,
          timeoutMs: config.azure.sendTimeoutMs,
        },
        blobName,
        line,
      );
      sentCount += 1;
    } catch (error) {
      console.error(
        `Azure send failed, ${lines.length - sentCount} sample(s) staying queued: ${(error as Error).message}`,
      );
      break;
    }
  }

  queue.replaceAll(lines.slice(sentCount));
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  collectAndSend()
    .then(({ queuedAfter }) => {
      if (queuedAfter > 0) {
        console.error(`${queuedAfter} sample(s) still queued after this run.`);
      }
    })
    .catch((error: unknown) => {
      console.error('Collector run failed:', error);
      process.exitCode = 1;
    });
}
