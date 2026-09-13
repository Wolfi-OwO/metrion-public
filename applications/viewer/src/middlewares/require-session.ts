import type { NextFunction, Request, Response } from 'express';
import { readSessionCookie, resolveSessionUserId } from '../auth/session.js';
import { UnauthorizedError } from './error.js';

/**
 * Guards every session-scoped route (`/api/v1/me`, the project and API-key
 * endpoints, `POST /auth/logout`). A missing cookie, a tampered cookie, and a
 * cookie naming an expired or already-logged-out session all answer the same
 * 401 - no branch tells a caller which of the three it hit, same reasoning as
 * `applications/ingest`'s `requireApiKey`.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      sessionId?: string;
    }
  }
}

export async function requireSession(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const sessionId = readSessionCookie(req);
  if (!sessionId) {
    next(new UnauthorizedError('A valid session is required.'));
    return;
  }

  const userId = await resolveSessionUserId(sessionId);
  if (!userId) {
    next(new UnauthorizedError('A valid session is required.'));
    return;
  }

  req.userId = userId;
  req.sessionId = sessionId;
  next();
}
