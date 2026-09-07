import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config/index.js';
import { ingestMetrics } from '../handlers/ingest.handlers.js';
import { bearerToken, requireIngestToken, tokenKey } from '../middlewares/auth.js';
import { asyncHandler } from '../middlewares/error.js';
import { validateBody } from '../middlewares/validate.js';
import { ingestBodySchema } from '../schemas/ingest.schemas.js';

/**
 * `POST /api/v1/ingest` - the write path for senders that do not already hold
 * a blob SAS.
 *
 * The collector deliberately does NOT use this. It keeps writing straight to
 * Azure Blob Storage, because a sender posting once a minute would wake this
 * `minReplicas: 0` container app 1440 times a day and it would never scale
 * back to zero - paying for a always-warm container to forward bytes to a
 * blob the sender can already reach on its own.
 */
export const ingestRouter = Router();

/**
 * Keyed by token, never by IP. Behind Azure Container Apps ingress the source
 * address is the proxy's, so an IP key would put every real sender in one
 * bucket - and reading a client IP is exactly what the privacy rules exclude.
 * The key is a hash, so the limiter's in-memory store never holds the secret.
 *
 * Mounted AFTER the auth check: an invalid token is rejected before it can
 * create a bucket, so a flood of random tokens cannot grow the store.
 */
const ingestRateLimiter = rateLimit({
  windowMs: config.ingestRateLimitWindowMs,
  limit: config.ingestRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const token = bearerToken(req);
    return token === null ? 'unauthenticated' : tokenKey(token);
  },
  // The default key generator is the client IP; this one deliberately is not,
  // so the built-in "did you forget to handle IPv6?" validator does not apply.
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'TooManyRequestsError', message: 'Too many requests.', statusCode: 429 },
});

ingestRouter.post(
  '/api/v1/ingest',
  requireIngestToken,
  ingestRateLimiter,
  // Bounded well above a realistic batch (200 envelopes of 1000 points would
  // not fit) and far below anything that could exhaust memory. Applied only
  // here: no other route accepts a body, so the app parses no JSON at all
  // unless an authenticated caller sent some.
  express.json({ limit: '256kb' }),
  validateBody(ingestBodySchema),
  asyncHandler(ingestMetrics),
);
