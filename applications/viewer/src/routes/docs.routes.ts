import { Router } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from '../docs/openapi.js';

/**
 * `/openapi.json` and the interactive `/docs`.
 *
 * Mounted in production too - unlike nutrilens, where these are dev-only. A
 * public API documentation site is an explicit requirement here, and there is
 * nothing to hide: the read endpoints are public and the spec documents only
 * the SHAPE of the ingest body, never a token.
 */
const openApiDocument = buildOpenApiDocument();

export const docsRouter = Router();

docsRouter.get('/openapi.json', (_req, res) => {
  res.json(openApiDocument);
});

// The global helmet() in main.ts sets a CSP with no 'unsafe-inline', which
// blocks Swagger UI's own bundled inline styles and its initialiser script -
// the page renders blank with only a console CSP violation to show for it.
// Re-applying helmet here overwrites the header for this path alone, leaving
// every other route's CSP untouched.
docsRouter.use(
  '/docs',
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  }),
  swaggerUi.serve,
  swaggerUi.setup(openApiDocument),
);
