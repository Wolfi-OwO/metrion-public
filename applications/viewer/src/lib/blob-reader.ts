import {
  AzureCliCredential,
  ChainedTokenCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import type { ContainerClient } from '@azure/storage-blob';
import { config } from '../config/index.js';
import { ServiceUnavailableError } from '../middlewares/error.js';

/**
 * Reads the collector's day-blobs.
 *
 * Authenticated with managed identity in Azure and `az login` locally, and NOT
 * with the collector's SAS token, which carries `ac` (add+create) only and can
 * neither read nor list. The two sides of this pipeline hold deliberately
 * different credentials.
 *
 * The chain is spelled out instead of using `DefaultAzureCredential`, which
 * looks equivalent but is not: its chain BEGINS with `EnvironmentCredential`,
 * so setting `AZURE_CLIENT_ID` + `AZURE_TENANT_ID` + `AZURE_CLIENT_SECRET` (or
 * a certificate path) silently switches the app onto a long-lived client
 * secret and it keeps working with no sign that anything changed. This deploy
 * is supposed to hold no storage secret at all - a system-assigned managed
 * identity with a container-scoped role. Naming the two credentials that are
 * wanted means an env var cannot introduce a third.
 *
 * Built once and shared with `blob-writer.ts`: the credential is stateless and
 * the client pools its sockets, so a second client would only buy extra TLS
 * handshakes and a second identity to keep in sync.
 */
let containerClient: ContainerClient | null = null;

export function getContainerClient(): ContainerClient {
  if (!config.azure.storageAccount) {
    throw new ServiceUnavailableError('Metrics storage is not configured.');
  }

  containerClient ??= new BlobServiceClient(
    `https://${config.azure.storageAccount}.blob.core.windows.net`,
    new ChainedTokenCredential(new ManagedIdentityCredential(), new AzureCliCredential()),
  ).getContainerClient(config.azure.container);

  return containerClient;
}

/** `<YYYY-MM-DD>` for a UTC day - the exact blob naming `dayBlobName` uses on the collector side. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Every UTC day name from `from` to `to`, inclusive. The range is already
 * bounded to 31 days by the query schema, so this list is short by
 * construction.
 */
export function utcDaysBetween(from: Date, to: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const last = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());

  while (cursor.getTime() <= last) {
    days.push(utcDay(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days;
}

/**
 * Hard ceiling on how much of one day-blob is read into memory.
 *
 * A real day measures 9,281 bytes per line x 1440 lines = 13.4 MB, so 64 MiB
 * is ~5x the busiest plausible day and no honest blob ever reaches it. The cap
 * exists because an append blob has no size limit this app controls: anything
 * holding the ingest token can append at the rate limit (120 requests/minute x
 * 256 kB) and grow today's blob past 40 GB in a day, at which point every
 * later read of that day - on a public, unauthenticated endpoint - would try
 * to buffer it whole and kill the container. Truncation costs at most the
 * final partial line, which `parseLines` already drops and reports through
 * `skippedLines` in the response rather than hiding.
 */
const MAX_DAY_BLOB_BYTES = 64 * 1024 * 1024;

/**
 * The lines of one day-blob, or `[]` if that day has none.
 *
 * A missing blob is a normal answer, not an error: the collector only creates
 * a day-blob on that day's first successful write, so any day the box was off
 * (or the range extends into the future) simply has no file. Listing the
 * container first would cost a round trip to learn the same thing this 404
 * already tells us.
 */
export async function readDayBlobLines(day: string): Promise<string[]> {
  const blobClient = getContainerClient().getBlobClient(`${day}.jsonl`);

  try {
    const buffer = await blobClient.downloadToBuffer(0, MAX_DAY_BLOB_BYTES);
    return buffer.toString('utf8').split('\n');
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 404) return [];
    throw error;
  }
}
