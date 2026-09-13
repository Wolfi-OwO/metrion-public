/**
 * The OpenAPI 3.0 document served at `/openapi.json` and rendered at `/docs`.
 *
 * Query parameters and response shapes are described here because OpenAPI
 * wants them per-parameter rather than as one object schema. No zod-derived
 * request body schema here any more - `POST /api/v1/ingest` (the one route
 * that had one) moved to `@metrion/ingest`, whose own `docs/openapi.ts` keeps
 * the same "converted from the runtime zod schema" pattern for its body.
 */

const errorResponse = {
  description: 'An error response, shared by every endpoint.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'ValidationError' },
          message: { type: 'string' },
          statusCode: { type: 'integer' },
          issues: {
            type: 'array',
            description: 'Present only on a 400 from the validation layer.',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, message: { type: 'string' } },
            },
          },
        },
      },
    },
  },
};

const rangeParameters = [
  {
    name: 'from',
    in: 'query',
    required: true,
    description:
      'Start of the range, ISO-8601. Required: a caller who forgets it gets a 400 naming the field, not a silent all-time query.',
    schema: { type: 'string', format: 'date-time' },
  },
  {
    name: 'to',
    in: 'query',
    required: true,
    description:
      'End of the range, ISO-8601. Must not be earlier than `from`. Ranges over 7 days are answered from the `metrics_hourly` rollup rather than the raw table - see the `source` field on `GET /api/v1/metrics`.',
    schema: { type: 'string', format: 'date-time' },
  },
];

export function buildOpenApiDocument(): object {
  return {
    openapi: '3.0.3',
    info: {
      title: 'metrion viewer API',
      version: '0.1.0',
      description:
        'Reads the minute-by-minute metrics the metrion agent sends, stored in Postgres/TimescaleDB.\n\n' +
        "Every response is scoped to the caller's own projects - see " +
        'docs/adr/0004-postgres-timescaledb-over-append-blob.md. No client IP, user agent, request ' +
        'path or query string exists anywhere in this pipeline - request metrics are aggregated per ' +
        'hostname only.\n\n' +
        'Writing metrics is done through the separate `@metrion/ingest` service, not this app - ' +
        'see its own `/openapi.json`.\n\n' +
        // Swagger UI renders `info.description` as Markdown at the top of the
        // page, so the legal links land on this second public surface without
        // `customCss`, `customJsStr`, or any widening of the deliberately
        // narrow CSP on the /docs route. Austrian ECG applies to this page as
        // much as to the app itself.
        'Legal: [Impressum](/impressum) | [Privacy Policy](/privacy) | ' +
        '[Terms of Use](/terms)',
    },
    tags: [
      { name: 'metrics', description: 'Reading stored metrics.' },
      { name: 'health', description: 'Liveness.' },
    ],
    paths: {
      '/api/v1/health/liveness': {
        get: {
          tags: ['health'],
          summary: 'Liveness probe.',
          responses: {
            '200': {
              description: 'The process is running.',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { status: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
      '/api/v1/resources': {
        get: {
          tags: ['metrics'],
          summary: 'Distinct resources, sub-resources and metric names seen in a range.',
          parameters: rangeParameters,
          responses: {
            '200': {
              description: 'What is available to chart.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      resources: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            resource: { type: 'string', example: 'vps-contabo-01' },
                            subResources: {
                              type: 'array',
                              items: { type: 'string', example: 'container:portfolio-caddy-1' },
                            },
                            metricNames: {
                              type: 'array',
                              items: { type: 'string', example: 'cpu.usage' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
          },
        },
      },
      '/api/v1/metrics': {
        get: {
          tags: ['metrics'],
          summary: 'One downsampled series.',
          parameters: [
            ...rangeParameters,
            {
              name: 'resource',
              in: 'query',
              required: true,
              schema: { type: 'string', example: 'vps-contabo-01' },
            },
            {
              name: 'subResource',
              in: 'query',
              required: false,
              description: 'Omit for the host-level series.',
              schema: { type: 'string', example: 'container:portfolio-caddy-1' },
            },
            {
              name: 'name',
              in: 'query',
              required: true,
              description:
                'Repeatable. Pass it once per metric to get them all from a single query - `name = ANY(...)`, not one round trip per name.',
              explode: true,
              schema: { type: 'array', items: { type: 'string', example: 'cpu.usage' } },
            },
            {
              name: 'stepSeconds',
              in: 'query',
              required: false,
              description: 'Bucket width. Floored at the collector’s own 60s sampling interval.',
              schema: { type: 'integer', minimum: 60, maximum: 86400, default: 60 },
            },
          ],
          responses: {
            '200': {
              description: 'The series, bucketed to `stepSeconds` and averaged within each bucket.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      series: {
                        type: 'array',
                        description: 'One entry per requested `name`, in the order asked for.',
                        items: {
                          type: 'object',
                          properties: {
                            resource: { type: 'string' },
                            subResource: { type: 'string', nullable: true },
                            name: { type: 'string' },
                            unit: { type: 'string', nullable: true },
                            stepSeconds: { type: 'integer' },
                            points: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  timestamp: { type: 'string', format: 'date-time' },
                                  value: { type: 'number' },
                                  count: {
                                    type: 'integer',
                                    description: 'Raw points the bucket average is over.',
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                      source: {
                        type: 'string',
                        enum: ['raw', 'hourly'],
                        description:
                          'Which table answered: `raw` for the `metrics` hypertable (ranges up to 7 days), `hourly` for the `metrics_hourly` continuous aggregate (wider ranges).',
                      },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
          },
        },
      },
    },
  };
}
