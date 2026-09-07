/**
 * Value and time formatting.
 *
 * `unit` is a free string on the wire - the collector sends `percent`, `MiB`,
 * `bytes/s`, `count`, `ms` and `bool` today, and a future sender can send
 * anything. So this is a lookup with a working fallback, never a switch that
 * assumes the current list: an unknown unit must still render a readable
 * number and its unit, not `undefined`.
 */

const BINARY_STEPS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

function binary(bytes: number): { value: number; suffix: string } {
  const sign = bytes < 0 ? -1 : 1;
  let value = Math.abs(bytes);
  let step = 0;
  while (value >= 1024 && step < BINARY_STEPS.length - 1) {
    value /= 1024;
    step += 1;
  }
  return { value: sign * value, suffix: BINARY_STEPS[step] ?? 'B' };
}

function trim(value: number, decimals: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

/** The number as it appears in a tooltip or a readout, unit included. */
export function formatValue(value: number, unit: string | null): string {
  if (!Number.isFinite(value)) return '-';

  switch (unit) {
    case 'percent':
      return `${trim(value, 1)}%`;
    case 'bool':
      return value >= 0.5 ? 'yes' : 'no';
    case 'bytes': {
      const scaled = binary(value);
      return `${trim(scaled.value, 1)} ${scaled.suffix}`;
    }
    case 'bytes/s': {
      const scaled = binary(value);
      return `${trim(scaled.value, 1)} ${scaled.suffix}/s`;
    }
    case 'count':
      // Not always a whole number: a bucket mean of a load average or a
      // request count is fractional, and rounding 1.95 to "2" is a small lie
      // on the one readout people compare against a threshold.
      return trim(value, Math.abs(value) >= 1000 ? 0 : 2);
    case null:
      return trim(value, 2);
    default:
      return `${trim(value, value >= 100 ? 0 : 2)} ${unit}`;
  }
}

/** The same number without its unit - the axis says the unit once, at the top. */
export function formatAxisValue(value: number, unit: string | null): string {
  if (!Number.isFinite(value)) return '';

  if (unit === 'bytes' || unit === 'bytes/s') {
    const scaled = binary(value);
    return `${trim(scaled.value, scaled.suffix === 'B' ? 0 : 1)}${scaled.suffix === 'B' ? '' : scaled.suffix[0]}`;
  }
  if (unit === 'bool') return value >= 0.5 ? 'yes' : 'no';
  if (Math.abs(value) >= 10_000) return `${trim(value / 1000, 0)}k`;
  return trim(value, Math.abs(value) >= 10 ? 0 : 2);
}

/**
 * A percent axis is pinned to 0-100 so a flat idle CPU reads as flat and idle
 * instead of being auto-scaled into dramatic noise between 0.2 and 0.4. The
 * upper bound still follows the data if something genuinely exceeds 100.
 */
export function axisDomain(unit: string | null, dataMax: number): [number, number | 'auto'] {
  if (unit === 'percent') return [0, Math.max(100, Math.ceil(dataMax))];
  if (unit === 'bool') return [0, 1];
  return [0, 'auto'];
}

/**
 * Explicit ticks where the unit has meaningful landmarks. Left to recharts, a
 * 0-100 axis divided into four came out as 0, 35, 70, 100 - arithmetically
 * even, and nothing a person reads a percentage against.
 */
export function axisTicks(unit: string | null): number[] | undefined {
  if (unit === 'percent') return [0, 50, 100];
  if (unit === 'bool') return [0, 1];
  return undefined;
}

/**
 * Timestamps are UTC on the wire and rendered in the reader's own zone, which
 * is the zone they are comparing against when they ask "what happened at nine
 * last night". The zone is named once under the axis so the two are never
 * confused - the collector's logs are UTC.
 */
export function timeZoneLabel(): string {
  const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(
    new Date(),
  );
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? 'local time';
}

/** Ticks lose the date on short ranges and lose the clock on long ones. */
export function formatTick(at: number, spanMs: number): string {
  const date = new Date(at);
  if (spanMs <= 36 * 60 * 60 * 1000) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (spanMs <= 8 * 24 * 60 * 60 * 1000) {
    return date.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function formatTimestamp(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "2 minutes ago" style, for the freshness readout in the header. */
export function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Bucket widths, spoken the way the footer needs them: "1 min", "15 min", "6 h", "1 d". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${seconds / 60} min`;
  if (seconds < 86_400) return `${seconds / 3600} h`;
  return `${seconds / 86_400} d`;
}
