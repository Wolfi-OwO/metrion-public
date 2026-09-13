import https from 'node:https';

const API_VERSION = '2021-08-06';

export interface AzureAppendBlobConfig {
  readonly storageAccount: string;
  readonly container: string;
  /** Container-scoped SAS query string, no leading `?`, permissions `ac` (add+create) only. */
  readonly sasToken: string;
  readonly timeoutMs: number;
}

interface AzureResponse {
  readonly statusCode: number;
  readonly body: string;
}

function request(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<AzureResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method, headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`Azure request timed out after ${timeoutMs}ms`)),
    );
    req.on('error', reject);
    req.end(body);
  });
}

function blobUrl(config: AzureAppendBlobConfig, blobName: string): URL {
  return new URL(
    `https://${config.storageAccount}.blob.core.windows.net/${config.container}/${blobName}?${config.sasToken}`,
  );
}

async function createAppendBlobIfMissing(
  config: AzureAppendBlobConfig,
  blobName: string,
): Promise<void> {
  const res = await request(
    'PUT',
    blobUrl(config, blobName),
    { 'x-ms-version': API_VERSION, 'x-ms-blob-type': 'AppendBlob', 'If-None-Match': '*' },
    '',
    config.timeoutMs,
  );
  // 201 = created. 409 (BlobAlreadyExists, from If-None-Match) = another
  // run/process already created it - fine, that's the point of the guard.
  if (res.statusCode !== 201 && res.statusCode !== 409) {
    throw new Error(`Azure create-append-blob failed: HTTP ${res.statusCode} ${res.body}`);
  }
}

/**
 * Appends one line (one run's `MetricEnvelope[]`, newline-terminated) to the
 * day's blob, creating it first if this is the day's first write.
 * Append Block's 4MiB-per-call limit is nowhere close for one JSON line.
 */
export async function appendLine(
  config: AzureAppendBlobConfig,
  blobName: string,
  line: string,
): Promise<void> {
  const body = line.endsWith('\n') ? line : `${line}\n`;
  const append = () =>
    request(
      'PUT',
      new URL(`${blobUrl(config, blobName).toString()}&comp=appendblock`),
      { 'x-ms-version': API_VERSION },
      body,
      config.timeoutMs,
    );

  let res = await append();
  if (res.statusCode === 404) {
    await createAppendBlobIfMissing(config, blobName);
    res = await append();
  }
  if (res.statusCode !== 201) {
    throw new Error(`Azure append-block failed: HTTP ${res.statusCode} ${res.body}`);
  }
}

/** UTC calendar day the blob is named after, e.g. `2026-09-05.jsonl`. */
export function dayBlobName(date: Date): string {
  return `${date.toISOString().slice(0, 10)}.jsonl`;
}
