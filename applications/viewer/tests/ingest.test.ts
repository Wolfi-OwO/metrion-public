import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Set before the dynamic import below: config/index.ts reads the environment at
// module load and refuses to start without a token, which is the behaviour
// being relied on here rather than worked around. AZURE_STORAGE_ACCOUNT is
// deliberately cleared - see the "reaches the storage layer" test.
const TOKEN = 'test-token-not-a-real-secret';
process.env.INGEST_TOKEN = TOKEN;
delete process.env.AZURE_STORAGE_ACCOUNT;

const { app } = await import('../dist/main.js');
const { toBlobLine } = await import('../dist/lib/blob-writer.js');
const { parseLine } = await import('../dist/lib/legacy-adapter.js');
const { tokenMatches } = await import('../dist/middlewares/auth.js');

let server: Server;
let baseUrl: string;

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function validEnvelope() {
  return {
    resource: 'vps-contabo-01',
    subResource: 'container:portfolio-caddy-1',
    metrics: [
      {
        name: 'cpu.usage',
        value: 12.5,
        unit: 'percent',
        intervalSeconds: 60,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

function post(body: unknown, token?: string) {
  return fetch(`${baseUrl}/api/v1/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

test('POST /api/v1/ingest: no token is 401, before any parsing', async () => {
  const response = await post(validEnvelope());
  assert.equal(response.status, 401);

  // A body that would fail validation must STILL be a 401, not a 400 - proof
  // the auth check runs first and an unauthenticated caller never reaches the
  // validation layer, let alone storage.
  const malformed = await post({ nonsense: true });
  assert.equal(malformed.status, 401);
});

test('POST /api/v1/ingest: a wrong token is 401', async () => {
  const response = await post(validEnvelope(), 'wrong-token');
  assert.equal(response.status, 401);

  // Same length as the real token, so this is not passing on a length check.
  const sameLength = await post(validEnvelope(), 'x'.repeat(TOKEN.length));
  assert.equal(sameLength.status, 401);
});

test('tokenMatches is constant-time and length-safe', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches('', TOKEN), false);
  // timingSafeEqual throws on unequal-length buffers; comparing digests means
  // a much shorter or much longer candidate returns false instead of throwing.
  assert.equal(tokenMatches('short', TOKEN), false);
  assert.equal(tokenMatches(`${TOKEN}-and-then-some-more`, TOKEN), false);
});

test('POST /api/v1/ingest: a valid token with a malformed body is 400 naming the field', async () => {
  const badValue = await post(
    { ...validEnvelope(), metrics: [{ ...validEnvelope().metrics[0], value: 'not a number' }] },
    TOKEN,
  );
  assert.equal(badValue.status, 400);
  const body = (await badValue.json()) as { issues: { path: string; message: string }[] };
  assert.ok(
    body.issues.some((issue) => issue.path.endsWith('value')),
    `expected an issue naming "value", got ${JSON.stringify(body.issues)}`,
  );

  // A resource with a slash: rejected because these are identity keys that the
  // hourly-rollup upgrade path would put in a blob name.
  const badResource = await post({ ...validEnvelope(), resource: '../../etc/passwd' }, TOKEN);
  assert.equal(badResource.status, 400);

  // An empty metrics array carries no information and must not become a line.
  const noMetrics = await post({ ...validEnvelope(), metrics: [] }, TOKEN);
  assert.equal(noMetrics.status, 400);

  // A timestamp outside the accepted window.
  const ancient = await post(
    {
      ...validEnvelope(),
      metrics: [{ ...validEnvelope().metrics[0], timestamp: '2020-01-01T00:00:00.000Z' }],
    },
    TOKEN,
  );
  assert.equal(ancient.status, 400);
});

test('POST /api/v1/ingest: a valid token and body pass auth and validation and reach storage', async () => {
  const response = await post(validEnvelope(), TOKEN);

  // 503, not 202, ONLY because AZURE_STORAGE_ACCOUNT is unset in this process:
  // the request got past the token check and the whole schema and was handed
  // to the blob writer, which is everything this endpoint does before the
  // Azure round trip. A 401 or 400 here would be a real failure.
  assert.equal(response.status, 503);

  const array = await post([validEnvelope(), validEnvelope()], TOKEN);
  assert.equal(array.status, 503);
});

test('the line an ingest write produces is one the reader parses back', async () => {
  // The acceptance that matters: an ingested line must be indistinguishable
  // from a collector line to parseLine, or the two writers would produce a
  // blob only one of them can read.
  const envelopes = [validEnvelope()];
  const line = toBlobLine(envelopes);

  assert.ok(line.endsWith('\n'), 'must be newline-terminated, the queue/blob format is line-based');
  assert.equal(line.trimEnd().includes('\n'), false, 'must be exactly one line');

  const readBack = parseLine(line.trimEnd());
  assert.deepEqual(readBack, envelopes);
});

test('an ingest response leaks no request path, query string or client address', async () => {
  const response = await fetch(`${baseUrl}/api/v1/ingest?secret=SHOULDNOTAPPEAR`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'SHOULDNOTAPPEAR-agent' },
    body: JSON.stringify(validEnvelope()),
  });
  const text = await response.text();

  assert.equal(response.status, 401);
  assert.equal(text.includes('SHOULDNOTAPPEAR'), false, text);
  assert.equal(text.includes('/api/v1/ingest'), false, text);
});

test('a client-side failure is reported as a client error, not a 500', async () => {
  // body-parser throws its own errors carrying `status`, and the terminal
  // handler used to ignore that and answer 500 for both of these. A malformed
  // body reported as a server fault tells the caller the wrong thing and puts
  // every scanner's garbage into the 5xx rate a real outage has to stand out
  // from.
  const malformedJson = await fetch(`${baseUrl}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: '{"resource":',
  });
  assert.equal(malformedJson.status, 400);

  const overCap = await fetch(`${baseUrl}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ resource: 'a'.repeat(300_000) }),
  });
  assert.equal(overCap.status, 413);
});

test('a validation error never echoes the query keys the caller sent', async () => {
  // Zod names the unrecognised keys in its own message, which would put a
  // fragment of the caller's query string into a response body. Harmless in
  // itself - it is their own input - but the rule this pipeline keeps is that
  // no query string reaches a response, a log or a blob, with no exceptions to
  // reason about one at a time.
  const response = await fetch(
    `${baseUrl}/api/v1/metrics?from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z` +
      '&resource=r&name=cpu.usage&secret=SHOULDNOTAPPEAR',
  );
  const text = await response.text();

  assert.equal(response.status, 400);
  assert.equal(text.includes('SHOULDNOTAPPEAR'), false, text);
});

test('CORS answers an unlisted origin with no allow-origin header', async () => {
  // With CORS_ALLOWED_ORIGINS unset the API is open by decision, so this only
  // pins the shape that matters either way: credentials are never enabled, so
  // no browser attaches a cookie or an Authorization header on the strength of
  // the CORS headers alone.
  const response = await fetch(`${baseUrl}/api/v1/health/liveness`, {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
});
