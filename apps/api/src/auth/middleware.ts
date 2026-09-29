import type { RequestHandler, Response } from 'express';
import type { Role } from '@duraknet/shared';
import { errors } from '../http/errors';
import { assertActiveSession, type AuthDeps } from './service';
import { verifyToken, type TokenClaims } from './tokens';

export function requireAuth(deps: AuthDeps, ...roles: Role[]): RequestHandler {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const claims = token ? verifyToken(deps.secrets.accessSecret, token, 'access') : null;
    if (!claims) throw errors.unauthorized();
    if (roles.length > 0 && !roles.includes(claims.role)) throw errors.forbidden();
    // Her istekte token_version + durum kontrolü: askıya alma/iptal access token süresini beklemez.
    await assertActiveSession(deps, claims);
    res.locals.auth = claims;
    next();
  };
}

export const authOf = (res: Response): TokenClaims => res.locals.auth as TokenClaims;
