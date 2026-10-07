import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pino, { type Logger } from 'pino';
import { adminRoutes } from './admin/routes';
import { createAuthLimiters, type AuthLimiters } from './auth/limits';
import { authRoutes } from './auth/routes';
import type { AuthDeps } from './auth/service';
import { errorHandler } from './http/errors';
import type { PresenceService } from './presence/service';
import type { RideService } from './rides/service';
import { noopRealtime, type Realtime } from './realtime';
import { standRoutes } from './stands/routes';

export type ReadinessCheck = { name: string; check: () => Promise<void> };

type BaseAppOptions = {
  readinessChecks?: ReadinessCheck[];
  realtime?: Realtime;
  /** Kimlik uçları için hız sınırlayıcılar. Verilmezse bellek içi (yalnızca test); üretimde server.ts Redis store'lu olanları verir. */
  authLimiters?: AuthLimiters;
  /** İzin verilen origin listesi; '*' yalnızca geliştirme içindir. */
  corsOrigin?: string[] | '*';
  log?: Logger;
  /** Ride servisi (Faz 3): askıya almada eşleşmiş ride'ı yeniden aramaya döndürmek için. Yoksa yalnızca presence temizlenir. */
  rides?: RideService | null;
  /** Load balancer arkasında gerçek istemci IP'si için (rate limit). */
  trustProxy?: boolean | number | string;
};

/**
 * `auth` verilirse `presence` zorunludur: askıya alma ve çıkışta şoför GEO'dan çıkarılır.
 * `null` = bilinçli olarak devre dışı (yalnızca kimlik testleri). `auth`'suz kurulum yalnızca /health ve /ready sunar.
 */
export type AppOptions = BaseAppOptions &
  ({ auth?: undefined; presence?: undefined } | { auth: AuthDeps; presence: PresenceService | null });

export function createApp(opts: AppOptions = {}) {
  const checks = opts.readinessChecks ?? [];
  const log = opts.log ?? pino({ level: 'silent' });
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', opts.trustProxy ?? false);
  app.use(helmet());
  app.use(cors({ origin: opts.corsOrigin ?? '*' }));
  app.use(express.json({ limit: '100kb' }));

  // Süreç ayakta mı (bağımlılıklara bakmaz).
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Trafik almaya hazır mı: PG ve Redis erişilebilir olmalı.
  app.get('/ready', async (_req, res) => {
    const results = await Promise.all(
      checks.map(async ({ name, check }) => {
        try {
          await check();
          return [name, 'ok'] as const;
        } catch {
          return [name, 'fail'] as const;
        }
      }),
    );
    const ready = results.every(([, s]) => s === 'ok');
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      checks: Object.fromEntries(results),
    });
  });

  if (opts.auth) {
    const realtime = opts.realtime ?? noopRealtime;
    app.use(authRoutes(opts.auth, opts.authLimiters ?? createAuthLimiters(), realtime, opts.presence ?? undefined));
    app.use(adminRoutes(opts.auth, realtime, opts.presence ?? undefined, opts.rides ?? undefined, log));
    app.use(standRoutes(opts.auth));
  }

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Bulunamadı' } });
  });
  app.use(errorHandler(log));

  return app;
}
