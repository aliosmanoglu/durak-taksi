import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pino, { type Logger } from 'pino';
import { adminRoutes } from './admin/routes';
import { createAuthLimiters, type AuthLimiters } from './auth/limits';
import { authRoutes } from './auth/routes';
import type { AuthDeps } from './auth/service';
import { errorHandler } from './http/errors';
import { noopRealtime, type Realtime } from './realtime';
import { standRoutes } from './stands/routes';

export type ReadinessCheck = { name: string; check: () => Promise<void> };

export type AppOptions = {
  readinessChecks?: ReadinessCheck[];
  auth?: AuthDeps;
  realtime?: Realtime;
  /** Kimlik uçları için hız sınırlayıcılar. Verilmezse bellek içi (yalnızca test); üretimde server.ts Redis store'lu olanları verir. */
  authLimiters?: AuthLimiters;
  /** İzin verilen origin listesi; '*' yalnızca geliştirme içindir. */
  corsOrigin?: string[] | '*';
  log?: Logger;
  /** Load balancer arkasında gerçek istemci IP'si için (rate limit). */
  trustProxy?: boolean | number | string;
};

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
    app.use(authRoutes(opts.auth, opts.authLimiters ?? createAuthLimiters(), realtime));
    app.use(adminRoutes(opts.auth, realtime));
    app.use(standRoutes(opts.auth));
  }

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Bulunamadı' } });
  });
  app.use(errorHandler(log));

  return app;
}
