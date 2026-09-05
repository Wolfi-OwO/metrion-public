import type { HostRequestStats } from '@vps-metrics/shared';
import { dockerGetRaw, demuxDockerLogStream } from '../lib/docker-socket.js';
import { readJsonState, writeJsonState } from '../lib/state-store.js';

/**
 * Caddy's structured access log line (see the global `log` block in
 * /opt/portfolio/Caddyfile). Deliberately typed as a narrow subset:
 * `request.host`, `status`, `duration` only. `request.remote_ip`,
 * `request.headers` (User-Agent) and `request.uri` (path + query string)
 * exist in the real line but are never read here - the privacy
 * requirement (no IPs, no UAs, no paths/query strings) is enforced by this
 * type simply not naming those fields, not by a filter that could miss one.
 */
interface CaddyAccessLogLine {
  readonly logger?: string;
  readonly status?: number;
  readonly duration?: number; // seconds
  readonly request?: { readonly host?: string };
}

interface CaddyLogCursor {
  readonly sinceEpochSeconds: number;
}

export function parseCaddyAccessLogLines(text: string): CaddyAccessLogLine[] {
  const lines: CaddyAccessLogLine[] = [];
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue; // a non-JSON or partial line - skip rather than fail the whole minute
    }
    const entry = parsed as CaddyAccessLogLine;
    // Caddy's other startup/TLS log lines have no `status` field - this is
    // what tells an access log line apart from the rest of stdout without
    // depending on the exact `logger` name (which has moved before, see
    // git history on the Caddyfile's own log block).
    if (typeof entry.status === 'number' && entry.request?.host) {
      lines.push(entry);
    }
  }
  return lines;
}

export function aggregateByHost(
  lines: readonly CaddyAccessLogLine[],
): Record<string, HostRequestStats> {
  const perHost: Record<
    string,
    { count: number; statusCounts: Record<string, number>; durationSecondsSum: number }
  > = {};
  for (const line of lines) {
    const host = line.request?.host ?? 'unknown';
    const bucket = (perHost[host] ??= { count: 0, statusCounts: {}, durationSecondsSum: 0 });
    bucket.count += 1;
    const statusKey = String(line.status);
    bucket.statusCounts[statusKey] = (bucket.statusCounts[statusKey] ?? 0) + 1;
    bucket.durationSecondsSum += line.duration ?? 0;
  }
  const result: Record<string, HostRequestStats> = {};
  for (const [host, bucket] of Object.entries(perHost)) {
    result[host] = {
      count: bucket.count,
      statusCounts: bucket.statusCounts,
      avgLatencyMs: bucket.count > 0 ? (bucket.durationSecondsSum / bucket.count) * 1000 : 0,
    };
  }
  return result;
}

/**
 * Reads whatever Caddy has logged since the last run's cursor and advances
 * it. `since` on the Docker Engine API is second-granularity, so a line
 * logged in the same second the previous run's cursor was taken could in
 * theory be read twice - a minor, described double-count risk at the
 * minute boundary, not a data-loss risk (ponytail: accepted ceiling, fix
 * would be switching to `--timestamps` with sub-second parsing if exact
 * counts ever matter more than they do for a dashboard).
 *
 * Robust to log rotation: the Docker Engine API's `/logs` endpoint (like
 * `docker logs` itself) reconstructs the stream from the current AND the
 * rotated json-file segments docker keeps (`max-file: 3` per the Caddyfile
 * header comment), not just the active file - so a collector run that's a
 * few minutes late doesn't miss anything as long as fewer than 3 rotations
 * (30MB of Caddy log) happened in the gap. A gap longer than that is the
 * real ceiling: those lines are gone from Docker's own log retention
 * before this collector ever gets a chance to read them, same as if you'd
 * run `docker logs` by hand too late.
 */
export async function collectHostRequestStats(
  socketPath: string,
  containerName: string,
  cursorStatePath: string,
): Promise<Record<string, HostRequestStats>> {
  const previousCursor = readJsonState<CaddyLogCursor>(cursorStatePath);
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  const since = previousCursor?.sinceEpochSeconds ?? nowEpochSeconds - 60;

  const raw = await dockerGetRaw(
    socketPath,
    `/containers/${encodeURIComponent(containerName)}/logs?stdout=1&since=${since}`,
  );
  const text = demuxDockerLogStream(raw);
  const lines = parseCaddyAccessLogLines(text);

  writeJsonState(cursorStatePath, { sinceEpochSeconds: nowEpochSeconds } satisfies CaddyLogCursor);
  return aggregateByHost(lines);
}
