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

// The API's own message names the field that failed validation, which is far
// more useful than "Request failed" - but it is only there when the body
// really is the documented error envelope. Shared by every caller below so a
// mutation's error reads exactly like a read's.
async function parseErrorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as ErrorBody;
  const detail = body.issues?.[0];
  return detail
    ? `${detail.path}: ${detail.message}`
    : (body.message ?? `HTTP ${response.status}.`);
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

  if (!response.ok) throw new ApiError(response.status, await parseErrorMessage(response));
  return (await response.json()) as T;
}

/**
 * `POST`/`DELETE` against the accounts and projects API. Same shape as
 * `getJson`, minus the query string and plus an optional JSON body - the
 * session cookie rides along automatically because every request here is
 * same-origin, exactly like the read calls above.
 */
async function sendJson<T>(
  path: string,
  method: 'POST' | 'DELETE',
  body: unknown,
  signal: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers:
        body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new ApiError(null, 'The projects API did not answer.');
  }

  if (!response.ok) throw new ApiError(response.status, await parseErrorMessage(response));
  // `POST /auth/logout` and `DELETE /api/v1/keys/:id` both answer 204 with no
  // body - reading `.json()` on that response throws on the empty string.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Mirrors `GET /api/v1/me` in `applications/viewer/src/handlers/auth.handlers.ts`. */
export interface MeResponse {
  readonly id: string;
  readonly email: string;
}

/**
 * `null` on a 401, not a thrown `ApiError` - "no session" is the expected
 * answer for a signed-out visitor, not a failure this app needs a retry
 * button for. Anything else (a 500, a dropped connection) still throws.
 */
export async function fetchMe(signal: AbortSignal): Promise<MeResponse | null> {
  let response: Response;
  try {
    response = await fetch('/api/v1/me', { signal, headers: { accept: 'application/json' } });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new ApiError(null, 'The account API did not answer.');
  }

  if (response.status === 401) return null;
  if (!response.ok) throw new ApiError(response.status, await parseErrorMessage(response));
  return (await response.json()) as MeResponse;
}

export function logout(signal: AbortSignal): Promise<void> {
  return sendJson<void>('/auth/logout', 'POST', undefined, signal);
}

/** Mirrors the row shape `listProjects`/`createProject` return in
 * `applications/viewer/src/handlers/projects.handlers.ts`. */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly defaultResource: string | null;
  readonly createdAt: string;
}

export function fetchProjects(signal: AbortSignal): Promise<Project[]> {
  return getJson<{ projects: Project[] }>('/api/v1/projects', new URLSearchParams(), signal).then(
    (body) => body.projects,
  );
}

export function createProject(name: string, signal: AbortSignal): Promise<Project> {
  return sendJson<Project>('/api/v1/projects', 'POST', { name }, signal);
}

/** What `POST /api/v1/projects/:id/keys` returns - the only response that
 * ever carries `key`, the plaintext secret. Nothing later re-reveals it: the
 * server stores only `key_hash` (`handlers/projects.handlers.ts`). */
export interface ApiKeyCreated {
  readonly id: string;
  readonly key: string;
  readonly keyPrefix: string;
  readonly createdAt: string;
}

export function createApiKey(projectId: string, signal: AbortSignal): Promise<ApiKeyCreated> {
  return sendJson<ApiKeyCreated>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/keys`,
    'POST',
    undefined,
    signal,
  );
}

export function revokeApiKey(keyId: string, signal: AbortSignal): Promise<void> {
  return sendJson<void>(`/api/v1/keys/${encodeURIComponent(keyId)}`, 'DELETE', undefined, signal);
}

/** `projectId` omitted narrows to nothing; passed, it scopes to just that one
 * project - `GET /api/v1/resources?projectId=`'s own behaviour
 * (`schemas/metrics.schemas.ts`, `middlewares/project-scope.ts`). */
export function fetchResources(
  from: Date,
  to: Date,
  signal: AbortSignal,
  projectId?: string,
): Promise<ResourcesResponse> {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (projectId) params.set('projectId', projectId);
  return getJson<ResourcesResponse>('/api/v1/resources', params, signal);
}

export interface SeriesQuery {
  readonly resource: string;
  readonly subResource?: string | undefined;
  readonly names: readonly string[];
  readonly from: Date;
  readonly to: Date;
  readonly stepSeconds: number;
  readonly projectId?: string | undefined;
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
  if (query.projectId) params.set('projectId', query.projectId);

  return getJson<SeriesBatch>('/api/v1/metrics', params, signal);
}

/** Mirrors the row shape `listApiKeys` returns in
 * `applications/viewer/src/handlers/projects.handlers.ts` - metadata only,
 * never the secret or its hash. */
export interface ApiKeySummary {
  readonly id: string;
  readonly keyPrefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export function fetchApiKeys(projectId: string, signal: AbortSignal): Promise<ApiKeySummary[]> {
  return getJson<{ keys: ApiKeySummary[] }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/keys`,
    new URLSearchParams(),
    signal,
  ).then((body) => body.keys);
}
