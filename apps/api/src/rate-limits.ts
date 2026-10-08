// Faz 5 hız sınırları (docs/design/faz5-resilience.md Bölüm 2). Kimlik uçlarının sınırları auth/limits.ts'te kalır.
// - REST: genel IP + kimlikli hesap + push-token ucu (express-rate-limit; üretimde Redis store, testte bellek içi).
// - Socket: olay başına hesap bazlı sabit pencere; tek Lua `INCR` + `PEXPIRE` (anahtar `redisKeys.eventRateLimit`).
//   Redis hatasında FAIL-OPEN: limitleyici kullanılabilirliği düşürmesin (loglanır + sayaç).
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { RequestHandler } from 'express';
import { rateLimit, type Store } from 'express-rate-limit';
import type { Redis } from 'ioredis';
import proxyaddr from 'proxy-addr';
import type { Logger } from 'pino';
import { RATE_LIMITS, redisKeys, type RateLimitedEvent } from '@duraknet/shared';
import { authOf } from './auth/middleware';
import { tooMany } from './auth/limits';
import { verifyToken } from './auth/tokens';
import { defineLua } from './presence/scripts';
import type { ApiMetrics } from './metrics';

export type Limit = { limit: number; windowMs: number };

export type RateLimitConfig = {
  restIp: Limit;
  restAccount: Limit;
  pushTokenPut: Limit;
  socketHandshakeIp: Limit;
  events: Record<RateLimitedEvent, Limit>;
};

/** Kısmi override (testler ve env). Biçim `RATE_LIMITS` ile aynıdır. */
export type RateLimitOverrides = Partial<Omit<RateLimitConfig, 'events'>> & {
  events?: Partial<RateLimitConfig['events']>;
};

export function resolveRateLimits(over: RateLimitOverrides = {}): RateLimitConfig {
  return {
    restIp: over.restIp ?? RATE_LIMITS.restIp,
    restAccount: over.restAccount ?? RATE_LIMITS.restAccount,
    pushTokenPut: over.pushTokenPut ?? RATE_LIMITS.pushTokenPut,
    socketHandshakeIp: over.socketHandshakeIp ?? RATE_LIMITS.socketHandshakeIp,
    events: { ...RATE_LIMITS.events, ...over.events },
  };
}

// ===== REST =====

export type RestLimiters = { ip: RequestHandler; account: RequestHandler; pushToken: RequestHandler };

type RestLimiterOptions = {
  limits: RateLimitConfig;
  /** Sayaç deposu üreticisi; verilmezse bellek içi (yalnızca test / tek süreç). */
  storeFor?: (prefix: string) => Store;
  metrics?: ApiMetrics;
  /** Hesap kimliği (JWT `sub`) çıkarmak için; imza doğrulanır, DB'ye gidilmez. */
  accessSecret?: string;
};

export function createRestLimiters(opts: RestLimiterOptions): RestLimiters {
  const { limits, storeFor, metrics } = opts;
  const make = (prefix: string, scope: string, l: Limit, extra: Parameters<typeof rateLimit>[0] = {}) =>
    rateLimit({
      windowMs: l.windowMs,
      limit: l.limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      // Depo (Redis) hatasında istek geçer: limitleyici erişilebilirliği düşürmesin.
      passOnStoreError: true,
      handler: (req, res) => {
        metrics?.rateLimitedTotal.inc({ scope });
        tooMany(req, res);
      },
      ...(storeFor ? { store: storeFor(`dn:ratelimit:${prefix}:`) } : {}),
      ...extra,
    });

  const ip = make('rest-ip', 'rest_ip', limits.restIp);

  // Kimlikli istekler: token imzası geçerliyse hesap bazlı sayılır; değilse yalnızca IP sınırı uygulanır.
  const account = make('rest-acct', 'rest_account', limits.restAccount, {
    skip: (_req, res) => !res.locals.rlAccount,
    keyGenerator: (_req, res) => res.locals.rlAccount as string,
  });
  const identify: RequestHandler = (req, res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const claims = token && opts.accessSecret ? verifyToken(opts.accessSecret, token, 'access') : null;
    if (claims) res.locals.rlAccount = `${claims.role}:${claims.sub}`;
    next();
  };

  const pushToken = make('push-token', 'push_token', limits.pushTokenPut, {
    keyGenerator: (_req, res) => authOf(res).sub,
  });

  return { ip, account: (req, res, next) => identify(req, res, (err?: unknown) => (err ? next(err) : account(req, res, next))), pushToken };
}

// ===== Socket =====

export interface EventLimiter {
  /** `true` = izin verildi. Redis hatasında da `true` (fail-open). `handshake` için `id` istemci IP'sidir. */
  allow(event: RateLimitedEvent | 'handshake', id: string): Promise<boolean>;
}

// KEYS[1]=sayaç  ARGV[1]=pencere(ms)  Döner: sayaç. TTL kaybolmuşsa (olmamalı) yeniden konur.
const HIT_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 or redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return c
`;

export function createEventLimiter(opts: {
  redis: Redis;
  limits: RateLimitConfig;
  log: Logger;
  metrics?: ApiMetrics;
}): EventLimiter {
  const { redis, limits, log, metrics } = opts;
  const hit = defineLua(redis, 'dnEventRateLimit', 1, HIT_LUA);
  return {
    async allow(event, id) {
      const l = event === 'handshake' ? limits.socketHandshakeIp : limits.events[event];
      try {
        const count = Number(await hit(redisKeys.eventRateLimit(event, id), l.windowMs));
        if (count > l.limit) {
          metrics?.rateLimitedTotal.inc({ scope: event === 'handshake' ? 'socket_handshake' : `event:${event}` });
          return false;
        }
        return true;
      } catch (err) {
        metrics?.rateLimitErrorsTotal.inc();
        log.warn({ err: err instanceof Error ? err.message : String(err), event }, 'olay hız sınırı Redis hatası; izin verildi');
        return true;
      }
    },
  };
}

/** Express `trust proxy` ayarını (false | true | hop sayısı | adres/alt ağ listesi) güvenilir-proxy işlevine çevirir. */
function compileTrust(v: boolean | number | string): (addr: string, i: number) => boolean {
  if (typeof v === 'boolean') return () => v;
  if (typeof v === 'number') return (_a, i) => i < v;
  return proxyaddr.compile(v.split(',').map((x) => x.trim()).filter(Boolean));
}

/**
 * Handshake'in istemci IP'si, Express'in `req.ip` ile aynı güvenilir-proxy mantığıyla (`proxy-addr`): doğrudan eş
 * güvenilir değilse `X-Forwarded-For` OKUNMAZ. Sonuç `net.isIP` ile doğrulanır; geçersizse bağlantı adresine düşülür
 * (rastgele başlık değerleriyle sayaç anahtarı şişirilemez).
 */
export function clientIpOf(req: Pick<IncomingMessage, 'headers' | 'socket'>, trustProxy: boolean | number | string): string {
  const direct = req.socket.remoteAddress ?? 'unknown';
  if (trustProxy === false) return direct;
  try {
    const ip = proxyaddr(req as IncomingMessage, compileTrust(trustProxy));
    return isIP(ip) ? ip : direct;
  } catch {
    return direct;
  }
}
