import { z } from 'zod';
import { DISPATCH, PRESENCE, PUSH, REMINDER } from '@duraknet/shared';

// .env.example boş değerleri ("EXPO_ACCESS_TOKEN=") tanımsız sayılır.
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const csvMs = (def: readonly number[]) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => Number(s.trim()) * 1000) : def.map((s) => s * 1000)))
    .pipe(z.array(z.number().positive()).min(1));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REDIS_URL: z.string().min(1),
  /** Faz 3 dispatch / hatırlatma / stand_nearby_drivers için gerekli (sweeper yalnızca Redis ister). */
  DATABASE_URL: z.string().min(1),
  /** Bu süredir konum göndermeyen (busy olmayan) şoför offline yapılır. */
  HEARTBEAT_STALE_MS: z.coerce.number().int().positive().default(PRESENCE.HEARTBEAT_STALE_MS),
  /** Sweeper tarama aralığı. */
  SWEEP_EVERY_MS: z.coerce.number().int().positive().default(PRESENCE.SWEEP_EVERY_MS),
  /** Dalga 1, 2, 3 sonrası bekleme (sn, virgüllü). Varsayılan 20,20,30. */
  DISPATCH_WAVE_DELAYS_S: csvMs(DISPATCH.WAVE_DELAY_S),
  /** Sürekli tarama aralığı (sn). */
  DISPATCH_SCAN_EVERY_S: z.coerce.number().positive().default(DISPATCH.CONTINUOUS_SCAN_EVERY_S),
  /** `ride_still_open`: ilk hatırlatmayı API zamanlar (API'de `REMINDER_FIRST_SEC`); sonrakiler bu aralıkla (sn). */
  REMINDER_EVERY_SEC: z.coerce.number().positive().default(REMINDER.EVERY_SEC),
  /** Uzlaştırıcı tarama aralığı (sn). */
  RECONCILE_EVERY_S: z.coerce.number().positive().default(30),
  /** `searching` ride bu süreden yeniyse job'sız sayılmaz (sn). */
  RECONCILE_MIN_AGE_S: z.coerce.number().positive().default(30),
  /** `created` ride bu süreden eskiyse yetim sayılıp `searching`'e alınır (sn). */
  RECONCILE_ORPHAN_AGE_S: z.coerce.number().positive().default(60),
  /** Uzlaştırıcının hatırlatmayı yeniden kurarken kullandığı ilk gecikme (API'deki `REMINDER_FIRST_SEC` ile aynı olmalı). */
  REMINDER_FIRST_SEC: z.coerce.number().positive().default(REMINDER.FIRST_SEC),
  NEARBY_EVERY_S: z.coerce.number().positive().default(DISPATCH.NEARBY_EVERY_S),
  LOCATION_FRESH_MS: z.coerce.number().int().positive().default(DISPATCH.LOCATION_FRESH_MS),
  // ===== Faz 5 =====
  /** false ise push gönderilmez ve push kuyrukları işlenmez. */
  PUSH_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** Expo erişim token'ı (isteğe bağlı). */
  EXPO_ACCESS_TOKEN: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  /** Push TTL (sn). */
  PUSH_TTL_S: z.coerce.number().int().positive().default(PUSH.TTL_S),
  /** Makbuz kontrolü gecikmesi (sn). */
  PUSH_RECEIPT_DELAY_S: z.coerce.number().int().positive().default(PUSH.RECEIPT_DELAY_S),
  /** /metrics Bearer token'ı; üretimde tanımsızsa uç kapalıdır (404). */
  METRICS_TOKEN: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  /** Tokensız /metrics (yalnızca yerel geliştirme). Token yoksa ve bu false ise uç 404 verir. */
  METRICS_ALLOW_ANON: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Worker health/ready/metrics HTTP portu (0 = rastgele boş port, testler için). */
  WORKER_HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(9102),
});

export type WorkerConfig = z.infer<typeof envSchema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Geçersiz ortam değişkenleri: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
