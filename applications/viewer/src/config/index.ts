/**
 * The only place `process.env` is read. Everything else imports `config`.
 * A missing required var fails loudly at boot, not as `undefined` three
 * calls deep into a request - the same rule (and the same shape) as
 * `applications/collector/src/config/index.ts`.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT) || 8080,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  /** pino level: trace/debug/info/warn/error/fatal/silent. */
  logLevel: process.env.LOG_LEVEL ?? 'info',

  azure: {
    /**
     * Optional on purpose. Unset means the read endpoints answer 503 rather
     * than the process refusing to boot: liveness, `/docs` and `/openapi.json`
     * stay useful without storage, and the container still starts so an
     * operator can see why. `INGEST_TOKEN` below is the opposite case.
     */
    storageAccount: process.env.AZURE_STORAGE_ACCOUNT,
    /**
     * Deliberately still `vps-metrics` - it holds real history and Azure has
     * no container rename. See the deployment runbook.
     */
    container: process.env.AZURE_CONTAINER ?? 'vps-metrics',
  },

  /**
   * Bearer token for `POST /api/v1/ingest`. Required: this is a public write
   * path on the internet, so booting without it would expose an unauthenticated
   * endpoint that appends to the same blobs the collector writes. Failing to
   * start is the safe direction.
   */
  ingestToken: requireEnv('INGEST_TOKEN'),

  /** Requests per window per token on the ingest endpoint. */
  ingestRateLimitMax: Number(process.env.INGEST_RATE_LIMIT_MAX) || 120,
  ingestRateLimitWindowMs: Number(process.env.INGEST_RATE_LIMIT_WINDOW_MS) || 60_000,

  /**
   * Requests per window across the WHOLE app, every caller together.
   *
   * The per-token ingest limiter sits behind the auth check, so before this
   * existed nothing was limited at all unless the caller already held a valid
   * token: a flood of 401s, and every request to the public read API, was
   * unmetered. Both cost real money here - the read path fans out to up to 31
   * blob reads per request, and any traffic at all pins a `minReplicas: 0`
   * container app at one warm replica around the clock.
   */
  globalRateLimitMax: Number(process.env.GLOBAL_RATE_LIMIT_MAX) || 300,
  globalRateLimitWindowMs: Number(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS) || 60_000,

  /**
   * Comma-separated browser origins allowed to call the API, e.g.
   * `https://mona.example.at`. Unset means any origin, which is the honest
   * default for a read API that is deliberately public and carries no cookie
   * or credential - but set it once the chart client has a real origin, so a
   * page nobody owns cannot drive this API from a visitor's browser.
   */
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
} as const;

export const isProduction = config.nodeEnv === 'production';
