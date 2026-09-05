import http from 'node:http';

/**
 * Talks to the Docker Engine API directly over the unix socket
 * (`http.request({ socketPath })` is stdlib - no `dockerode`/CLI subprocess
 * needed for a handful of GET calls once a minute).
 *
 * GET-only, by construction: there is no function here that issues
 * anything but a GET. That is the concrete "eingrenzen" for a process that
 * otherwise has root-equivalent socket access (see SECURITY notes in the
 * delivery report) - a code review of this one file is enough to confirm
 * the collector can list/inspect/read logs and nothing else.
 */
export async function dockerGetJson<T>(socketPath: string, apiPath: string): Promise<T> {
  const body = await dockerGetRaw(socketPath, apiPath);
  return JSON.parse(body.toString('utf8')) as T;
}

export function dockerGetRaw(socketPath: string, apiPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: apiPath, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(
            new Error(
              `Docker API ${apiPath} -> HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`,
            ),
          );
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Docker's non-TTY log stream multiplexes stdout/stderr behind an 8-byte
 * frame header per chunk: 1 byte stream type, 3 bytes padding, 4 bytes
 * big-endian payload length. This strips the framing and returns the plain
 * text lines - the same demultiplexing `docker logs` itself does, done by
 * hand because the raw stream is what the API gives you.
 */
export function demuxDockerLogStream(raw: Buffer): string {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const length = raw.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > raw.length) break; // truncated final frame - ignore rather than throw
    lines.push(raw.subarray(start, end).toString('utf8'));
    offset = end;
  }
  return lines.join('');
}
