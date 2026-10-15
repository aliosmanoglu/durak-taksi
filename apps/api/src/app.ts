import cors from 'cors';
import express from 'express';
import type { Store } from 'express-rate-limit';
import type { Redis } from 'ioredis';
import helmet from 'helmet';
import pino, { type Logger } from 'pino';
import { adminRoutes } from './admin/routes';
import { createAuthLimiters, type AuthLimiters } from './auth/limits';
import { authRoutes } from './auth/routes';
import type { AuthDeps } from './auth/service';
import { errorHandler } from './http/errors';
import { apiMetrics, metricsHandler, type ApiMetrics } from './metrics';
import type { PresenceService } from './presence/service';
import { reportRoutes } from './reports/routes';
import { pushTokenRoutes } from './push/routes';
import type { PushNotifier } from './push/notifier';
import { createRestLimiters, resolveRateLimits, type RateLimitOverrides } from './rate-limits';
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
  /** Faz 5 hız sınırı override'ı (varsayılan `RATE_LIMITS`; env veya test için). */
  rateLimits?: RateLimitOverrides;
  /** Faz 5 REST limit sayaç deposu üreticisi. Verilmezse bellek içi (yalnızca test); üretimde server.ts Redis store verir. */
  rateLimitStore?: (prefix: string) => Store;
  /** Prometheus metrikleri; verilmezse süreç genelindeki varsayılan. */
  metrics?: ApiMetrics;
  /** `/metrics` Bearer token'ı. Tanımsızsa uç her ortamda kapalıdır (404); `metricsAllowAnon` ile açılır. */
  metricsToken?: string;
  /** Tokensız `/metrics` erişimine izin ver (yalnızca yerel geliştirme; METRICS_ALLOW_ANON=true). Varsayılan false. */
  metricsAllowAnon?: boolean;
  /** true dönerse `/ready` 503 verir (graceful shutdown başladı). */
  isShuttingDown?: () => boolean;
  /** Şoför askıya alınınca `account_suspended` push job'ı atar (yoksa bildirim gönderilmez). */
  pushNotifier?: PushNotifier;
  /** Faz 6 tutarlılık raporu (salt okunur) için Redis; verilmezse `/admin/reports/consistency` eklenmez. */
  redis?: Redis;
  /** `stale_created` eşiği (sn); worker RECONCILE_ORPHAN_AGE_S ile aynı olmalı. Varsayılan 60. */
  staleCreatedAgeS?: number;
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
    if (opts.isShuttingDown?.()) {
      res.status(503).json({ status: 'shutting_down', checks: {} });
      return;
    }
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

  // Prometheus: hız sınırından muaf (health/ready gibi). Token kuralı için bkz. metricsHandler.
  const metrics = opts.metrics ?? apiMetrics();
  app.get('/metrics', metricsHandler(metrics.registry, {
    ...(opts.metricsToken ? { token: opts.metricsToken } : {}),
    allowAnon: opts.metricsAllowAnon ?? false,
  }));

  // Faz 5 genel REST sınırları (yukarıdaki sağlık/metrik uçlarından SONRA: onlar muaf).
  const limiters = createRestLimiters({
    limits: resolveRateLimits(opts.rateLimits),
    ...(opts.rateLimitStore ? { storeFor: opts.rateLimitStore } : {}),
    metrics,
    ...(opts.auth ? { accessSecret: opts.auth.secrets.accessSecret } : {}),
  });
  app.use(limiters.ip);
  app.use(limiters.account);

  if (opts.auth) {
    const realtime = opts.realtime ?? noopRealtime;
    app.use(authRoutes(opts.auth, opts.authLimiters ?? createAuthLimiters(), realtime, opts.presence ?? undefined));
    app.use(adminRoutes(opts.auth, realtime, opts.presence ?? undefined, opts.rides ?? undefined, log, opts.pushNotifier));
    app.use(reportRoutes(opts.auth, opts.redis, opts.staleCreatedAgeS ?? 60));
    app.use(standRoutes(opts.auth));
    app.use(pushTokenRoutes(opts.auth, limiters.pushToken));
  }

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Bulunamadı' } });
  });
  app.use(errorHandler(log));

  return app;
}
