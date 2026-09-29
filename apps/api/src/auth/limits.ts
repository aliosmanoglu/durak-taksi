import type { Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit, type Store } from 'express-rate-limit';
import { loginSchema } from '@duraknet/shared';

export type AuthLimiters = {
  register: RequestHandler;
  /** IP başına; kaba kuvvet tek adresten. */
  loginByIp: RequestHandler;
  /** Hesap başına, yalnızca başarısız denemeler; dağıtık (çok IP'li) kaba kuvvete karşı. */
  loginByAccount: RequestHandler;
  /** Gevşek: Türkiye mobil operatörlerinde CGNAT yüzünden çok sayıda şoför aynı IP'yi paylaşır. */
  refresh: RequestHandler;
};

export function tooMany(_req: Request, res: Response) {
  res.status(429).json({ ok: false, error: { code: 'RATE_LIMITED', message: 'Çok fazla deneme, biraz bekleyin' } });
}

// Hesap anahtarı giriş şemasıyla normalize edilir: "0532 123 45 67" ve "+905321234567" aynı sayaca düşer.
function accountKey(req: Request): string {
  const r = loginSchema.safeParse(req.body);
  if (!r.success) return `invalid:${ipKeyGenerator(req.ip ?? '')}`;
  return r.data.role === 'driver' ? `driver:${r.data.phone}` : `${r.data.role}:${r.data.username}`;
}

/**
 * @param storeFor Sayaç deposu üreticisi. Üretimde Redis (tüm node'lar aynı sayacı görür);
 *                 verilmezse bellek içi (yalnızca test / tek süreç).
 */
export function createAuthLimiters(storeFor?: (prefix: string) => Store): AuthLimiters {
  const make = (prefix: string, windowMs: number, limit: number, extra: Parameters<typeof rateLimit>[0] = {}) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: tooMany,
      ...(storeFor ? { store: storeFor(`dn:ratelimit:${prefix}:`) } : {}),
      ...extra,
    });

  return {
    register: make('register', 60 * 60_000, 20),
    loginByIp: make('login-ip', 60_000, 60),
    loginByAccount: make('login-acct', 15 * 60_000, 10, {
      keyGenerator: accountKey,
      skipSuccessfulRequests: true,
    }),
    refresh: make('refresh', 60_000, 600),
  };
}
