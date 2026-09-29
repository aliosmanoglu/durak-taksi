import jwt from 'jsonwebtoken';
import { ROLES, type AuthTokens, type Role } from '@duraknet/shared';

export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;

export type TokenClaims = { sub: string; role: Role; tv: number };
/** Doğrulanmış token: `exp` saniye cinsinden (JWT standardı). */
export type VerifiedClaims = TokenClaims & { exp: number };
type TokenType = 'access' | 'refresh';

export type TokenSecrets = { accessSecret: string; refreshSecret: string };

export function issueTokens(secrets: TokenSecrets, claims: TokenClaims): AuthTokens {
  const sign = (typ: TokenType, secret: string, expiresIn: number) =>
    jwt.sign({ role: claims.role, tv: claims.tv, typ }, secret, {
      subject: claims.sub,
      expiresIn,
      algorithm: 'HS256',
    });
  return {
    accessToken: sign('access', secrets.accessSecret, ACCESS_TTL_SEC),
    refreshToken: sign('refresh', secrets.refreshSecret, REFRESH_TTL_SEC),
    accessExpiresIn: ACCESS_TTL_SEC,
  };
}

/** Geçersiz / süresi dolmuş / yanlış tipte token için null döner. */
export function verifyToken(secret: string, token: string, expected: TokenType): VerifiedClaims | null {
  try {
    const p = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (typeof p !== 'object' || p.typ !== expected || typeof p.sub !== 'string') return null;
    if (!ROLES.includes(p.role) || !Number.isInteger(p.tv) || typeof p.exp !== 'number') return null;
    return { sub: p.sub, role: p.role as Role, tv: p.tv as number, exp: p.exp };
  } catch {
    return null;
  }
}
