import { z } from 'zod';
import type { ZodType } from 'zod';
import { ingestBodySchema } from '../schemas/ingest.schemas.js';
import { MAX_RANGE_DAYS } from '../schemas/metrics.schemas.js';

/**
 * The OpenAPI 3.0 document served at `/openapi.json` and rendered at `/docs`.
 *
 * The ingest request body comes from the same zod schema
 * `middlewares/validate.ts` enforces at runtime, so the published contract
 * cannot drift from what the endpoint accepts. Query parameters and response
 * shapes are described here because OpenAPI wants them per-parameter rather
 * than as one object schema.
 */

function schema(zodSchema: ZodType): object {
  // Zod 4's own converter, NOT the third-party zod-to-json-schema package:
  // that package's parser reads Zod 3-shaped internals and silently returns
  // `{}` for a native Zod 4 schema like the ones in schemas/*.ts. It fails
  // quietly - an empty request body in the docs, no error anywhere - so do not
  // "fix" this back to the third-party package.
  return z.toJSONSchema(zodSchema, { target: 'openapi-3.0' });
}

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
    description: `Start of the range, ISO-8601. Required: the range is what bounds the scan, and it may not exceed ${MAX_RANGE_DAYS} days.`,
    schema: { type: 'string', format: 'date-time' },
  },
  {
    name: 'to',
    in: 'query',
    required: true,
    description: `End of the range, ISO-8601. At most ${MAX_RANGE_DAYS} days after \`from\`.`,
    schema: { type: 'string', format: 'date-time' },
  },
];

export function buildOpenApiDocument(): object {
  return {
    openapi: '3.0.3',
    info: {
      title: 'mona viewer API',
      version: '0.1.0',
      description:
        'Reads the minute-by-minute metrics the mona collector writes to Azure Blob Storage.\n\n' +
        'The read endpoints are public: this is aggregate resource usage of my own machines. ' +
        'No client IP, user agent, request path or query string exists anywhere in this pipeline - ' +
        'request metrics are aggregated per hostname only.\n\n' +
        'Only `POST /api/v1/ingest` is authenticated.\n\n' +
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
      { name: 'ingest', description: 'Submitting metrics from a sender without a blob SAS.' },
      { name: 'health', description: 'Liveness.' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'The ingest token. Never published here - it is deployment configuration.',
        },
      },
    },
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
                      skippedLines: {
                        type: 'integer',
                        description: 'Blob lines that could not be parsed and were dropped.',
                      },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
            '503': errorResponse,
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
                'Repeatable. Pass it once per metric to get them all from a single scan of the day-blobs - one request costs one cross-region download, so asking for 36 metrics separately costs 36 of them.',
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
                      skippedLines: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/api/v1/ingest': {
        post: {
          tags: ['ingest'],
          summary: 'Append one or more metric envelopes.',
          description:
            'For senders that do not already hold a blob SAS. The mona collector does not use ' +
            'this endpoint - it writes to the blob directly, so it never has to wake this ' +
            'scale-to-zero container.\n\nRate limited per token.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schema(ingestBodySchema) } },
          },
          responses: {
            '202': {
              description: 'Appended.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      accepted: { type: 'integer' },
                      points: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '429': errorResponse,
            '503': errorResponse,
          },
        },
      },
    },
  };
}
