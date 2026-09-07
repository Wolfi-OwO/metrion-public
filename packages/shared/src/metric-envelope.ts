/**
 * The wire format the collector writes and the viewer reads.
 *
 * Generic on purpose: the previous shape hard-coded one VPS's fields
 * (`cpu`, `memory`, `disk`, ...), so every new kind of sender meant a
 * schema change on both sides. `resource`/`subResource`/`metrics[]` lets a
 * sender describe itself without the schema knowing what it is.
 *
 * One JSONL line is a JSON *array* of these - not one envelope per line.
 * See ADR 0003 for why.
 *
 * The privacy exclusions carry over unchanged: no client IPs, no user
 * agents, no request paths or query strings ever enter an envelope.
 * Request metrics are aggregated per hostname only.
 */
export interface MetricPoint {
  /** Dotted, e.g. `cpu.usage`, `memory.used`. */
  readonly name: string;
  readonly value: number;
  /** e.g. `percent`, `MiB`, `bytes/s`, `count`, `ms`. */
  readonly unit: string;
  readonly intervalSeconds: number;
  /** ISO-8601 UTC. */
  readonly timestamp: string;
}

export interface MetricEnvelope {
  /** The sender, e.g. `vps-contabo-01`. */
  readonly resource: string;
  /** e.g. `container:portfolio-caddy-1`. */
  readonly subResource?: string;
  readonly metrics: readonly MetricPoint[];
}
