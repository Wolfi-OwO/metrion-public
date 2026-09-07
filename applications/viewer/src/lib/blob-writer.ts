import type { MetricEnvelope } from '@mona/shared';
import { getContainerClient, utcDay } from './blob-reader.js';

/**
 * Appends ingested envelopes to the same day-blob the collector writes.
 *
 * One storage shape, one reader: the line this produces is byte-compatible
 * with what `applications/collector` appends, so `parseLine` cannot tell an
 * ingested line from a collected one - which is the whole point of routing
 * both through `MetricEnvelope[]`.
 */

/** One request becomes exactly one newline-terminated JSON array, as ADR 0003 requires. */
export function toBlobLine(envelopes: readonly MetricEnvelope[]): string {
  return `${JSON.stringify(envelopes)}\n`;
}

/**
 * ponytail: writes to the blob of the CURRENT UTC day, not the day each point's
 * own timestamp falls in. The 24h backdating window the ingest schema allows
 * means a point written just after midnight can land in today's blob carrying
 * yesterday's timestamp - still found by any query whose range covers today,
 * invisible only to a query for yesterday alone. Upgrade path if that ever
 * matters: group the envelopes by their points' UTC day and append one line
 * per day instead of one per request.
 */
export async function appendEnvelopes(envelopes: readonly MetricEnvelope[]): Promise<void> {
  const client = getContainerClient().getAppendBlobClient(`${utcDay(new Date())}.jsonl`);

  // The collector creates the day's blob on its first write of the day; this
  // is the same call, and a no-op when it already exists.
  await client.createIfNotExists();

  const line = toBlobLine(envelopes);
  await client.appendBlock(line, Buffer.byteLength(line));
}
