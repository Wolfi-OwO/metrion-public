import fs from 'node:fs';
import os from 'node:os';

/** The aggregate `cpu ` line of `/proc/stat`: user nice system idle iowait irq softirq steal. */
export interface CpuTicks {
  readonly total: number;
  readonly idle: number;
}

export function parseProcStatCpuLine(text: string): CpuTicks {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) {
    throw new Error('no aggregate "cpu " line in /proc/stat');
  }
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (values[3] ?? 0) + (values[4] ?? 0); // idle + iowait
  const total = values.reduce((sum, v) => sum + v, 0);
  return { total, idle };
}

export function readProcStatCpu(): CpuTicks {
  return parseProcStatCpuLine(fs.readFileSync('/proc/stat', 'utf8'));
}

/** Usage% between two samples of the same counter - the actual math, kept separate so it's testable without real ticks. */
export function usagePercentBetween(before: CpuTicks, after: CpuTicks): number {
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  if (totalDelta <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

/**
 * Instantaneous CPU usage%, sampled by reading `/proc/stat` twice `windowMs`
 * apart. Deliberately not cross-invocation state: one fewer file to manage,
 * and 200ms added to the run is well inside the "must not take seconds"
 * constraint (measured - see delivery report's "Own footprint").
 */
export async function measureCpuUsagePercent(windowMs = 200): Promise<number> {
  const before = readProcStatCpu();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const after = readProcStatCpu();
  return usagePercentBetween(before, after);
}

export function readLoadAverage(): readonly [number, number, number] {
  return os.loadavg() as [number, number, number];
}

export function countVcpus(): number {
  return os.cpus().length;
}
