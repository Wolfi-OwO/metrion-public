/**
 * The only place this app talks to the network.
 *
 * Every URL is a bare `/api/...` path: the Vite dev server proxies those to
 * `localhost:8080`, and in production this bundle is meant to be served by the
 * same Express app - so there is no base URL to configure and no CORS on
 * either side. That second half is intent, not yet fact: nothing calls
 * `express.static` in `applications/viewer/src` today, and until it does these
 * paths only resolve behind the dev proxy.
 */

/** Mirrors `ResourceSummary` in `applications/viewer/src/services/metrics-service.ts`. */
export interface ResourceSummary {
  readonly resource: string;
  readonly subResources: string[];
  readonly metricNames: string[];
}

export interface ResourcesResponse {
  readonly resources: ResourceSummary[];
  readonly skippedLines: number;
}

export interface SeriesPoint {
  readonly timestamp: string;
  readonly value: number;
  /** Raw samples behind the bucket mean. An honest 1 beats a smooth-looking lie. */
  readonly count: number;
}

export interface SeriesResult {
  readonly resource: string;
  readonly subResource?: string;
  readonly name: string;
  /** `null` when the range held no point for this metric, so the unit is unknown. */
  readonly unit: string | null;
  readonly stepSeconds: number;
  readonly points: SeriesPoint[];
}

/** What `GET /api/v1/metrics` returns: every requested name, from one scan. */
export interface SeriesBatch {
  readonly series: SeriesResult[];
  readonly skippedLines: number;
}

/**
 * One failure type for the whole app. `status === null` means the request never
 * reached a server - a dropped API, a dead network, a rejected DNS lookup - and
 * the UI says so in those words rather than inventing an HTTP code for it.
 */
export class ApiError extends Error {
  readonly status: number | null;

  constructor(status: number | null, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }

  /** 503 is the viewer's own answer when blob storage is not configured. */
  get isStorageUnavailable(): boolean {
    return this.status === 503;
  }
}

interface ErrorBody {
  message?: string;
  issues?: { path: string; message: string }[];
}

async function getJson<T>(path: string, params: URLSearchParams, signal: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${path}?${params}`, {
      signal,
      headers: { accept: 'application/json' },
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new ApiError(null, 'The metrics API did not answer.');
  }

  if (!response.ok) {
    // The API's own message names the field that failed validation, which is
    // far more useful than "Request failed" - but it is only there when the
    // body really is the documented error envelope.
    const body = (await response.json().catch(() => ({}))) as ErrorBody;
    const detail = body.issues?.[0];
    throw new ApiError(
      response.status,
      detail ? `${detail.path}: ${detail.message}` : (body.message ?? `HTTP ${response.status}.`),
    );
  }

  return (await response.json()) as T;
}

export function fetchResources(
  from: Date,
  to: Date,
  signal: AbortSignal,
): Promise<ResourcesResponse> {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  return getJson<ResourcesResponse>('/api/v1/resources', params, signal);
}

export interface SeriesQuery {
  readonly resource: string;
  readonly subResource?: string | undefined;
  readonly names: readonly string[];
  readonly from: Date;
  readonly to: Date;
  readonly stepSeconds: number;
}

/**
 * Every requested metric in ONE request.
 *
 * `name` is repeated rather than joined: sub-resource and metric names are
 * free-form, so any delimiter would eventually appear inside a name. The
 * server reads the day-blobs once and answers for all of them - it used to
 * take a single name, which meant one 18 MB cross-region download per metric
 * and a five-minute page for a host with 36 of them.
 */
export function fetchSeries(query: SeriesQuery, signal: AbortSignal): Promise<SeriesBatch> {
  const params = new URLSearchParams({
    resource: query.resource,
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    stepSeconds: String(query.stepSeconds),
  });
  for (const name of query.names) params.append('name', name);
  // `subResource` is `.strict()`-validated upstream: sending it empty is a 400,
  // so an absent sub-resource means an absent parameter.
  if (query.subResource) params.set('subResource', query.subResource);

  return getJson<SeriesBatch>('/api/v1/metrics', params, signal);
}
