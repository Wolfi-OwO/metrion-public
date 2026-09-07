import { Router } from 'express';
import { docsRouter } from './docs.routes.js';
import { healthRouter } from './health.routes.js';
import { ingestRouter } from './ingest.routes.js';
import { legalRouter } from './legal.routes.js';
import { metricsRouter } from './metrics.routes.js';

/** Every route the app serves, mounted in one place. */
export const routes = Router();

routes.use(healthRouter);
routes.use(metricsRouter);
routes.use(ingestRouter);
routes.use(docsRouter);
// Before the SPA fallback in main.ts, so `/impressum` renders the Impressum
// rather than the chart app.
routes.use(legalRouter);
