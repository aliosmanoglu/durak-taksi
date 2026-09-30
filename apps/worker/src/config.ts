import { z } from 'zod';
import { DISPATCH, PRESENCE, REMINDER } from '@duraknet/shared';

const csvMs = (def: readonly number[]) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => Number(s.trim()) * 1000) : def.map((s) => s * 1000)))
    .pipe(z.array(z.number().positive()).min(1));

const envSchema = z.object({
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
  NEARBY_EVERY_S: z.coerce.number().positive().default(DISPATCH.NEARBY_EVERY_S),
  LOCATION_FRESH_MS: z.coerce.number().int().positive().default(DISPATCH.LOCATION_FRESH_MS),
});

export type WorkerConfig = z.infer<typeof envSchema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Geçersiz ortam değişkenleri: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
