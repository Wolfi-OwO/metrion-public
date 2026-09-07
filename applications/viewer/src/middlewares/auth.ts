import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/index.js';
import { UnauthorizedError } from './error.js';

const BEARER_PREFIX = 'Bearer ';

/** The `Authorization: Bearer <token>` value, or `null` if the header is absent or malformed. */
export function bearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header || !header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Constant-time token comparison.
 *
 * `===` on a secret short-circuits at the first differing byte, which leaks
 * the shared prefix length through response timing and lets a token be
 * recovered byte by byte. `timingSafeEqual` does not - but it THROWS on
 * buffers of different lengths, and a naive length check before it would leak
 * the token's length through that branch instead. Comparing SHA-256 digests
 * sidesteps both: the digests are always 32 bytes, so the buffers are equal
 * length by construction and no length information is observable.
 */
export function tokenMatches(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/** A stable, non-secret key for the rate limiter - never the token itself. */
export function tokenKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Guards the ingest write path. Rejects before any body parsing or validation
 * runs, so an unauthenticated caller never gets the app to allocate a request
 * body, let alone touch storage.
 */
export function requireIngestToken(req: Request, _res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  if (token === null || !tokenMatches(token, config.ingestToken)) {
    next(new UnauthorizedError('A valid bearer token is required.'));
    return;
  }
  next();
}
