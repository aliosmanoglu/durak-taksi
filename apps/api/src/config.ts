import { z } from 'zod';
import { RATE_LIMITS, REMINDER } from '@duraknet/shared';
import type { RateLimitOverrides } from './rate-limits';

// .env.example boş değerleri ("RATE_LIMIT_X=") tanımsız sayılır.
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalLimit = z.preprocess(blankToUndefined, z.coerce.number().int().positive().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, 'en az 32 karakter olmalı'),
  JWT_REFRESH_SECRET: z.string().min(32, 'en az 32 karakter olmalı'),
  // Tek yönetici hesabı (CLAUDE.md Bölüm 1). Hash: `pnpm --filter @duraknet/api hash-password`
  ADMIN_USERNAME: z.string().min(1),
  ADMIN_PASSWORD_HASH: z.string().startsWith('$argon2', 'argon2 hash olmalı'),
  // Artırılınca tüm yönetici oturumları düşer.
  ADMIN_TOKEN_VERSION: z.coerce.number().int().nonnegative().default(0),
  // İlk `ride_still_open` hatırlatmasının gecikmesi (sn); sonrakiler worker'da REMINDER_EVERY_SEC ile.
  REMINDER_FIRST_SEC: z.coerce.number().positive().default(REMINDER.FIRST_SEC),
  // Express 'trust proxy': 'false' | önümüzdeki proxy sayısı (ör. 1) | güvenilen adresler ('loopback, 10.0.0.0/8').
  // Yanlış değer rate limit'i atlatılabilir veya tüm istemcileri tek IP gösterir; dağıtım topolojisine göre ayarla.
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v): boolean | number | string => (v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v)),
  // ===== Faz 5 =====
  // Şoför askıya alınınca `account_suspended` push job'ı atılsın mı (gönderimi worker yapar).
  PUSH_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // /metrics Bearer token'ı; üretimde tanımsızsa uç kapalıdır (404).
  METRICS_TOKEN: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  /** Tokensız /metrics (yalnızca yerel geliştirme). Token yoksa ve bu false ise uç 404 verir. */
  METRICS_ALLOW_ANON: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Kapanış: LB'nin node'u çıkarması için bekleme ve zorla çıkış süresi (ms).
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().nonnegative().default(5000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  // ===== Faz 6 =====
  // Tutarlılık raporunda `stale_created` eşiği (sn); worker RECONCILE_ORPHAN_AGE_S ile aynı değer olmalı.
  RECONCILE_ORPHAN_AGE_S: z.coerce.number().positive().default(60),
  // Hız sınırları (istek sayısı); pencere süreleri `RATE_LIMITS`'te sabittir. Boşsa varsayılan.
  RATE_LIMIT_REST_IP_PER_MIN: optionalLimit,
  RATE_LIMIT_REST_ACCOUNT_PER_MIN: optionalLimit,
  RATE_LIMIT_PUSH_TOKEN_PER_10MIN: optionalLimit,
  RATE_LIMIT_SOCKET_HANDSHAKE_IP_PER_MIN: optionalLimit,
  RATE_LIMIT_RIDE_CREATE_PER_MIN: optionalLimit,
  RATE_LIMIT_RIDE_ACCEPT_PER_MIN: optionalLimit,
  RATE_LIMIT_RIDE_DECLINE_PER_MIN: optionalLimit,
  RATE_LIMIT_RIDE_CANCEL_PER_MIN: optionalLimit,
  RATE_LIMIT_RIDE_COMPLETE_PER_MIN: optionalLimit,
  RATE_LIMIT_RIDE_DRIVER_CANCEL_PER_MIN: optionalLimit,
  RATE_LIMIT_DRIVER_PRESENCE_PER_MIN: optionalLimit,
  RATE_LIMIT_SESSION_SYNC_PER_MIN: optionalLimit,
  RATE_LIMIT_AUTH_REFRESH_PER_MIN: optionalLimit,
  // Virgülle ayrılmış origin listesi (ör. https://panel.duraknet.com). '*' yalnızca geliştirme içindir.
  CORS_ORIGINS: z
    .string()
    .default('*')
    .transform((v): string[] | '*' => (v.trim() === '*' ? '*' : v.split(',').map((s) => s.trim()).filter(Boolean))),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Geçersiz ortam değişkenleri: ${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.JWT_ACCESS_SECRET === parsed.data.JWT_REFRESH_SECRET) {
    throw new Error('JWT_ACCESS_SECRET ve JWT_REFRESH_SECRET farklı olmalı');
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.CORS_ORIGINS === '*') {
    throw new Error('Üretimde CORS_ORIGINS açıkça tanımlanmalı');
  }
  return parsed.data;
}

/** `RATE_LIMIT_*` env değerlerini `RateLimitOverrides`'e çevirir (yalnızca verilenler; pencereler `RATE_LIMITS`'ten). */
export function rateLimitOverridesOf(c: Config): RateLimitOverrides {
  const pick = (limit: number | undefined, base: { windowMs: number }) =>
    limit === undefined ? undefined : { limit, windowMs: base.windowMs };
  const ev = RATE_LIMITS.events;
  const events = {
    ride_create: pick(c.RATE_LIMIT_RIDE_CREATE_PER_MIN, ev.ride_create),
    ride_accept: pick(c.RATE_LIMIT_RIDE_ACCEPT_PER_MIN, ev.ride_accept),
    ride_decline: pick(c.RATE_LIMIT_RIDE_DECLINE_PER_MIN, ev.ride_decline),
    ride_cancel: pick(c.RATE_LIMIT_RIDE_CANCEL_PER_MIN, ev.ride_cancel),
    ride_complete: pick(c.RATE_LIMIT_RIDE_COMPLETE_PER_MIN, ev.ride_complete),
    ride_driver_cancel: pick(c.RATE_LIMIT_RIDE_DRIVER_CANCEL_PER_MIN, ev.ride_driver_cancel),
    driver_go_online: pick(c.RATE_LIMIT_DRIVER_PRESENCE_PER_MIN, ev.driver_go_online),
    driver_go_offline: pick(c.RATE_LIMIT_DRIVER_PRESENCE_PER_MIN, ev.driver_go_offline),
    session_sync_request: pick(c.RATE_LIMIT_SESSION_SYNC_PER_MIN, ev.session_sync_request),
    auth_refresh: pick(c.RATE_LIMIT_AUTH_REFRESH_PER_MIN, ev.auth_refresh),
  };
  const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  return {
    ...defined({
      restIp: pick(c.RATE_LIMIT_REST_IP_PER_MIN, RATE_LIMITS.restIp),
      restAccount: pick(c.RATE_LIMIT_REST_ACCOUNT_PER_MIN, RATE_LIMITS.restAccount),
      pushTokenPut: pick(c.RATE_LIMIT_PUSH_TOKEN_PER_10MIN, RATE_LIMITS.pushTokenPut),
      socketHandshakeIp: pick(c.RATE_LIMIT_SOCKET_HANDSHAKE_IP_PER_MIN, RATE_LIMITS.socketHandshakeIp),
    }),
    events: defined(events),
  };
}
