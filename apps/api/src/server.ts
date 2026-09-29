import { createServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import pino from 'pino';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { createApp } from './app';
import { createAuthLimiters } from './auth/limits';
import type { AuthDeps } from './auth/service';
import { loadConfig } from './config';
import { createDb } from './db';
import { createPresence } from './presence/service';
import { createRealtime } from './realtime';

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
const authLimiters = createAuthLimiters(
  (prefix) =>
    new RedisStore({
      prefix,
      sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>,
    }),
);

const { io, realtime, attach } = createRealtime(auth, log, {
  corsOrigin: config.CORS_ORIGINS,
  presence,
  adapter: createAdapter(adapterPub, adapterSub),
});

const app = createApp({
  auth,
  realtime,
  presence,
  authLimiters,
  log,
  corsOrigin: config.CORS_ORIGINS,
  trustProxy: config.TRUST_PROXY,
  readinessChecks: [
    { name: 'postgres', check: async () => void (await pool.query('SELECT 1')) },
    { name: 'redis', check: async () => void (await redis.ping()) },
  ],
});

// Sıra önemli: önce Express, sonra Socket.io (bkz. createRealtime açıklaması).
const httpServer = createServer(app);
attach(httpServer);

httpServer.listen(config.PORT, () => log.info({ port: config.PORT }, 'api dinliyor'));

async function shutdown(signal: string) {
  log.info({ signal }, 'kapanıyor');
  await new Promise<void>((resolve) => io.close(() => resolve()));
  await Promise.allSettled([db.destroy(), redis.quit(), adapterPub.quit(), adapterSub.quit()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
