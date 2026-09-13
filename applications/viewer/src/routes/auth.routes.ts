import { Router } from 'express';
import { authCallback, logout, me, startAuth } from '../handlers/auth.handlers.js';
import { asyncHandler } from '../middlewares/error.js';
import { requireSession } from '../middlewares/require-session.js';

/**
 * Sign-in, sign-out, and "who am I". `/auth/*` (not `/api/v1/*`) for the two
 * routes a browser navigates to directly rather than fetches - a redirect
 * and a redirect target read better outside the JSON API's own prefix.
 */
export const authRouter = Router();

authRouter.get('/auth/:provider', asyncHandler(startAuth));
authRouter.get('/auth/:provider/callback', asyncHandler(authCallback));
authRouter.post('/auth/logout', asyncHandler(requireSession), asyncHandler(logout));
authRouter.get('/api/v1/me', asyncHandler(requireSession), asyncHandler(me));
