import { createServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import pino from 'pino';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { createApp } from './app';
import { createAuthLimiters } from './auth/limits';
import type { AuthDeps } from './auth/service';
import { loadConfig, rateLimitOverridesOf } from './config';
import { createDb } from './db';
import { createGracefulShutdown } from './lifecycle';
import { apiMetrics } from './metrics';
import { createPresence } from './presence/service';
import { createPushNotifier } from './push/notifier';
import { createRealtime } from './realtime';
import { createDispatchScheduler } from './rides/scheduler';
import { createRideService } from './rides/service';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });

const { db, pool } = createDb(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
redis.on('error', (err) => log.warn({ err: err.message }, 'redis hatası'));

// Socket.io redis-adapter: node'lar arası yayın (odalar, disconnectSockets). Abone olan bağlantı başka komut
// çalıştıramaz; bu yüzden pub ve sub ayrı bağlantılardır.
const adapterPub = redis.duplicate();
const adapterSub = redis.duplicate();
for (const c of [adapterPub, adapterSub]) c.on('error', (err) => log.warn({ err: err.message }, 'redis adapter hatası'));

const presence = createPresence(redis);

// Dispatch/hatırlatma job'ları BullMQ'dadır (zamanlama ve işleme worker'da); API yalnızca kuyruğa ekler.
const bullConnection = redis.duplicate({ maxRetriesPerRequest: null });
bullConnection.on('error', (err) => log.warn({ err: err.message }, 'bullmq redis hatası'));
const scheduler = createDispatchScheduler(bullConnection, { reminderFirstMs: config.REMINDER_FIRST_SEC * 1000 });

const auth: AuthDeps = {
  db,
  secrets: { accessSecret: config.JWT_ACCESS_SECRET, refreshSecret: config.JWT_REFRESH_SECRET },
  admin: {
    username: config.ADMIN_USERNAME,
    passwordHash: config.ADMIN_PASSWORD_HASH,
    tokenVersion: config.ADMIN_TOKEN_VERSION,
  },
};

// Sayaçlar Redis'te: tüm API node'ları aynı limitleri paylaşır.
const redisStoreFor = (prefix: string) =>
  new RedisStore({
    prefix,
    sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>,
  });
const authLimiters = createAuthLimiters(redisStoreFor);

// Faz 5: hız sınırı ayarları (env ile ezilir), metrikler, şoför askıya alma push job'ı.
const rateLimits = rateLimitOverridesOf(config);
const metrics = apiMetrics();
const pushNotifier = config.PUSH_ENABLED ? createPushNotifier(bullConnection) : undefined;
if (pushNotifier) {
  log.info("PUSH_ENABLED=true: account_suspended job'ları 'push' kuyruğuna atılır; worker'da da PUSH_ENABLED=true olmalı (aksi halde birikir)");
}

const { io, realtime, rides, attach } = createRealtime(auth, log, {
  corsOrigin: config.CORS_ORIGINS,
  presence,
  rides: (sink) => createRideService({ db, redis, log, sink, scheduler, metrics }),
  adapter: createAdapter(adapterPub, adapterSub),
  redis,
  rateLimits,
  trustProxy: config.TRUST_PROXY,
  metrics,
});

const app = createApp({
  auth,
  realtime,
  presence,
  rides,
  authLimiters,
  log,
  corsOrigin: config.CORS_ORIGINS,
  trustProxy: config.TRUST_PROXY,
  rateLimits,
  rateLimitStore: redisStoreFor,
  metrics,
  ...(config.METRICS_TOKEN ? { metricsToken: config.METRICS_TOKEN } : {}),
  metricsAllowAnon: config.METRICS_ALLOW_ANON,
  isShuttingDown: () => lifecycle.isShuttingDown(),
  ...(pushNotifier ? { pushNotifier } : {}),
  readinessChecks: [
    { name: 'postgres', check: async () => void (await pool.query('SELECT 1')) },
    { name: 'redis', check: async () => void (await redis.ping()) },
  ],
});

// Sıra önemli: önce Express, sonra Socket.io (bkz. createRealtime açıklaması).
const httpServer = createServer(app);
attach(httpServer);

httpServer.listen(config.PORT, () => log.info({ port: config.PORT }, 'api dinliyor'));

const lifecycle = createGracefulShutdown({
  log,
  drainMs: config.SHUTDOWN_DRAIN_MS,
  timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  httpServer,
  io,
  closeResources: async () => {
    await Promise.allSettled([scheduler.close(), pushNotifier?.close()]);
    await Promise.allSettled([db.destroy(), redis.quit(), adapterPub.quit(), adapterSub.quit(), bullConnection.quit()]);
  },
});
process.on('SIGTERM', () => void lifecycle.shutdown('SIGTERM'));
process.on('SIGINT', () => void lifecycle.shutdown('SIGINT'));
