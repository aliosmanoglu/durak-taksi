import { z } from 'zod';
import { REMINDER } from '@duraknet/shared';

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
