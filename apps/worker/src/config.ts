import { z } from 'zod';
import { PRESENCE } from '@duraknet/shared';

const envSchema = z.object({
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REDIS_URL: z.string().min(1),
  /** Bu süredir konum göndermeyen (busy olmayan) şoför offline yapılır. */
  HEARTBEAT_STALE_MS: z.coerce.number().int().positive().default(PRESENCE.HEARTBEAT_STALE_MS),
  /** Sweeper tarama aralığı. */
  SWEEP_EVERY_MS: z.coerce.number().int().positive().default(PRESENCE.SWEEP_EVERY_MS),
});

export type WorkerConfig = z.infer<typeof envSchema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Geçersiz ortam değişkenleri: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
