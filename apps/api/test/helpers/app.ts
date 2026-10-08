// Entegrasyon testleri için gerçek bağımlılıklarla (PG + Redis) uygulama kurulumu.
// server.ts ile aynı bağlama: Redis store'lu hız sınırlayıcılar, presence, createServer(app) → attach.
// `redisAdapter: true` ile socket.io redis-adapter kurulur: aynı PG/Redis'e bağlı iki startTestApp
// çağrısı iki API node'unu simüle eder (disconnectAccount vb. node'lar arası davranış).
import { randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import pino from 'pino';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../../src/app';
import { createGracefulShutdown, type GracefulShutdown } from '../../src/lifecycle';
import { createAuthLimiters } from '../../src/auth/limits';
import { hashPassword } from '../../src/auth/password';
import type { AuthDeps } from '../../src/auth/service';
import { createDb } from '../../src/db';
import { createPresence } from '../../src/presence/service';
import { createRealtime } from '../../src/realtime';
import type { DispatchScheduler } from '../../src/rides/scheduler';
import { createRideService } from '../../src/rides/service';

export const ADMIN_USERNAME = 'yonetici';
export const ADMIN_PASSWORD = 'yonetici-sifre-123';
export const PASSWORD = 'gizli-sifre-123';

/** Her çağrıda farklı istemci IP'si: IP bazlı limitler testler arasında birbirini etkilemesin. */
export const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

const digits = (n: number) => Array.from({ length: n }, () => randomInt(10)).join('');
const letters = (n: number) => Array.from({ length: n }, () => String.fromCharCode(65 + randomInt(26))).join('');

/** Yerel yazımla benzersiz telefon (ör. "0532 123 45 67") ve normalize hali. */
export function uniquePhone() {
  const d = `5${digits(9)}`;
  return {
    local: `0${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8)}`,
    e164: `+90${d}`,
  };
}
export const uniquePlate = () => `34${letters(3)}${digits(4)}`;
export const uniqueUsername = () => `durak_${letters(4).toLowerCase()}${digits(6)}`;

export type TestApp = Awaited<ReturnType<typeof startTestApp>>;

export type StartTestAppOptions = {
  redisAdapter?: boolean;
  /** Faz 3: ride servisini kurar (verilmezse ride event'leri kapalı; Faz 1–2 testleri böyle koşar). */
  scheduler?: DispatchScheduler;
  /**
   * Faz 5 enjeksiyon noktaları (backend uygulaması bitince adları burada tek yerde ayarlanır):
   * createApp / createRealtime seçeneklerine eklenir (hız sınırı override'ı, metrikler, push kuyruğu vb.).
   */
  appExtras?: Record<string, unknown>;
  realtimeExtras?: Record<string, unknown>;
};

export async function startTestApp(opts: StartTestAppOptions = {}) {
  const { db, pool } = createDb(inject('pgUrl'));
  const redis = new Redis(inject('redisUrl'), { maxRetriesPerRequest: 1 });
  const log = pino({ level: 'silent' });
  const presence = createPresence(redis);
  const adapterClients = opts.redisAdapter ? [redis.duplicate(), redis.duplicate()] as const : undefined;

  const deps: AuthDeps = {
    db,
    secrets: { accessSecret: 'a'.repeat(40), refreshSecret: 'r'.repeat(40) },
    admin: { username: ADMIN_USERNAME, passwordHash: await hashPassword(ADMIN_PASSWORD), tokenVersion: 0 },
  };

  const authLimiters = createAuthLimiters(
    (prefix) =>
      new RedisStore({
        prefix,
        sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>,
      }),
  );

  const { io, realtime, rides, attach } = createRealtime(deps, log, {
    corsOrigin: '*',
    presence,
    // Faz 5: server.ts ile aynı — socket olay/handshake hız sınırları Redis üzerinde (override: opts.realtimeExtras.rateLimits).
    redis,
    trustProxy: 'loopback',
    rides: opts.scheduler
      ? (sink) => createRideService({ db, redis, log, sink, scheduler: opts.scheduler! })
      : undefined,
    adapter: adapterClients ? createAdapter(adapterClients[0], adapterClients[1]) : undefined,
    ...opts.realtimeExtras,
  } as Parameters<typeof createRealtime>[2]);
  // Adapter aboneliklerini namespace oluşturulurken (createRealtime içinde) kuyruğa alır; ioredis komutları
  // sırayla işler. Bu PING döndüğünde abonelikler etkindir: ilk node'lar arası yayın kaybolmaz.
  if (adapterClients) await adapterClients[1].ping();
  let shutdownCtl: GracefulShutdown | undefined;
  const app = createApp({
    auth: deps,
    isShuttingDown: () => shutdownCtl?.isShuttingDown() ?? false,
    // /metrics tokensız her ortamda 404'tür; testler okuyabilsin diye varsayılan açık (token/404 testleri ezer).
    metricsAllowAnon: true,
    // Faz 6: tutarlılık raporu Redis'i okur.
    redis,
    realtime,
    presence,
    rides,
    authLimiters,
    log,
    corsOrigin: '*',
    // Testler X-Forwarded-For ile farklı istemci IP'leri simüle eder.
    trustProxy: 'loopback',
    readinessChecks: [
      { name: 'postgres', check: async () => void (await pool.query('SELECT 1')) },
      { name: 'redis', check: async () => void (await redis.ping()) },
    ],
    ...opts.appExtras,
  } as Parameters<typeof createApp>[0]);

  const httpServer: Server = createServer(app);
  attach(httpServer);
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  // Test sonunda temizlenecek kaynaklar.
  const created = { drivers: new Set<string>(), stands: new Set<string>() };
  const sockets = new Set<Socket>();

  /** Tek bir istemci IP'sinden gelen HTTP istekleri. */
  function http(ip = randomIp()) {
    return {
      get: (path: string) => request(url).get(path).set('X-Forwarded-For', ip),
      post: (path: string) => request(url).post(path).set('X-Forwarded-For', ip),
      patch: (path: string) => request(url).patch(path).set('X-Forwarded-For', ip),
      put: (path: string) => request(url).put(path).set('X-Forwarded-For', ip),
      delete: (path: string) => request(url).delete(path).set('X-Forwarded-For', ip),
    };
  }

  async function registerDriver() {
    const phone = uniquePhone();
    const plate = uniquePlate();
    const res = await http()
      .post('/auth/driver/register')
      .send({ fullName: 'Test Şoför', phone: phone.local, password: PASSWORD, plate, licenseNo: 'RUHSAT-1', kvkkAccepted: true });
    if (res.status !== 201) throw new Error(`şoför kaydı başarısız: ${res.status} ${JSON.stringify(res.body)}`);
    const id = res.body.data.id as string;
    created.drivers.add(id);
    return { id, phone, plate, status: res.body.data.status as string };
  }

  async function registerStand(location = { lat: 41.0082, lng: 28.9784 }) {
    const username = uniqueUsername();
    const res = await http()
      .post('/auth/stand/register')
      .send({ name: 'Test Durağı', phone: uniquePhone().local, location, username, password: PASSWORD, kvkkAccepted: true });
    if (res.status !== 201) throw new Error(`durak kaydı başarısız: ${res.status} ${JSON.stringify(res.body)}`);
    const id = res.body.data.id as string;
    created.stands.add(id);
    return { id, username, status: res.body.data.status as string };
  }

  let adminAccess: string | undefined;
  async function adminToken() {
    if (!adminAccess) {
      const res = await http().post('/auth/login').send({ role: 'admin', username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
      if (res.status !== 200) throw new Error(`admin girişi başarısız: ${res.status} ${JSON.stringify(res.body)}`);
      adminAccess = res.body.data.accessToken as string;
    }
    return adminAccess;
  }

  async function adminAction(kind: 'drivers' | 'stands', id: string, action: 'approve' | 'suspend') {
    const res = await http()
      .post(`/admin/${kind}/${id}/${action}`)
      .set('Authorization', `Bearer ${await adminToken()}`);
    if (res.status !== 200) throw new Error(`admin ${action} başarısız: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data as { id: string; status: string };
  }

  const loginDriver = (phone: string, password = PASSWORD) =>
    http().post('/auth/login').send({ role: 'driver', phone, password });
  const loginStand = (username: string, password = PASSWORD) =>
    http().post('/auth/login').send({ role: 'stand', username, password });

  async function approvedDriver() {
    const d = await registerDriver();
    await adminAction('drivers', d.id, 'approve');
    const res = await loginDriver(d.phone.e164);
    if (res.status !== 200) throw new Error(`şoför girişi başarısız: ${res.status} ${JSON.stringify(res.body)}`);
    return { ...d, tokens: res.body.data as { accessToken: string; refreshToken: string } };
  }

  async function approvedStand() {
    const s = await registerStand();
    await adminAction('stands', s.id, 'approve');
    const res = await loginStand(s.username);
    if (res.status !== 200) throw new Error(`durak girişi başarısız: ${res.status} ${JSON.stringify(res.body)}`);
    return { ...s, tokens: res.body.data as { accessToken: string; refreshToken: string } };
  }

  function socket(nsp: '/driver' | '/stand' | '/', token: string | undefined, opts: Parameters<typeof connect>[1] = {}) {
    // Her soket kendi sahte istemci IP'sinden gelir (Faz 5 handshake IP sınırı testler arasında birikmesin);
    // trustProxy 'loopback' olduğundan X-Forwarded-For'un son girdisi kullanılır.
    const s = connect(`${url}${nsp}`, {
      reconnection: false, forceNew: true, auth: token ? { token } : {},
      extraHeaders: { 'X-Forwarded-For': randomIp() }, ...opts,
    });
    sockets.add(s);
    return s;
  }

  /** Bağlanırsa socket'i döndürür; connect_error olursa reddeder. */
  function connectOk(nsp: '/driver' | '/stand', token: string): Promise<Socket> {
    const s = socket(nsp, token);
    return new Promise((resolve, reject) => {
      s.once('connect', () => resolve(s));
      s.once('connect_error', (err: Error) => reject(new Error(`beklenmedik connect_error: ${err.message}`)));
    });
  }

  /** connect_error bekler; bağlantı kurulursa reddeder. */
  function connectError(nsp: '/driver' | '/stand' | '/', token: string | undefined, opts: Parameters<typeof connect>[1] = {}) {
    const s = socket(nsp, token, opts);
    return new Promise<{ message: string; data: unknown }>((resolve, reject) => {
      s.once('connect', () => {
        s.close();
        reject(new Error('beklenmedik bağlantı'));
      });
      s.once('connect_error', (err: Error & { data?: unknown }) => {
        s.close();
        resolve({ message: err.message, data: err.data });
      });
    });
  }

  /** Her testten sonra: açık socket'leri kapat, testin oluşturduğu hesapları sil. */
  async function cleanup() {
    for (const s of sockets) s.close();
    sockets.clear();
    if (created.drivers.size) await db.deleteFrom('drivers').where('id', 'in', [...created.drivers]).execute();
    if (created.stands.size) await db.deleteFrom('stands').where('id', 'in', [...created.stands]).execute();
    created.drivers.clear();
    created.stands.clear();
  }

  let shutDown = false;
  let exitCode: Promise<number> | undefined;
  /**
   * server.ts'in graceful shutdown'u (createGracefulShutdown): /ready 503 → drain → http close → io.close.
   * `process.exit` yerine çıkış kodu döner (0 = temiz, 1 = zaman aşımı). Tekrar çağrı aynı sözü döndürür.
   */
  function shutdown(o: { drainMs: number; timeoutMs: number }): Promise<number> {
    if (exitCode) return exitCode;
    shutDown = true;
    exitCode = new Promise<number>((resolve) => {
      shutdownCtl = createGracefulShutdown({
        log, drainMs: o.drainMs, timeoutMs: o.timeoutMs, httpServer, io,
        closeResources: async () => undefined, // test close() kaynakları kapatır
        exit: resolve,
      });
      void shutdownCtl.shutdown('TEST');
    });
    return exitCode;
  }

  let killed = false;
  /**
   * Sert node kaybı: süreç ölmüş gibi TCP bağlantıları kesilir, adapter'ın Redis bağlantıları düşer
   * (ölü node fetchSockets/Pub-Sub isteklerine yanıt vermez). Socket.io'ya düzgün kapanış yaptırılmaz.
   */
  function kill() {
    killed = true;
    // Ölü süreç handler çalıştırmaz: kopma dinleyicilerini (afterStandClose vb.) sök, yoksa bağlantısı kesilmiş
    // adapter'a yazıp unhandled rejection üretirler (yalnızca süreç-içi simülasyon artefaktı).
    for (const nsp of io._nsps.values()) for (const sock of nsp.sockets.values()) sock.removeAllListeners();
    for (const c of adapterClients ?? []) c.disconnect();
    // WebSocket'e yükseltilmiş bağlantılar http sunucusunun takibinde değildir: TCP soketlerini doğrudan yok et.
    for (const c of Object.values((io.engine as unknown as { clients: object }).clients) as {
      transport?: { socket?: { terminate?: () => void } };
      request?: { socket?: { destroy(): void } };
    }[]) {
      c.transport?.socket?.terminate?.(); // websocket
      c.request?.socket?.destroy(); // polling
    }
    httpServer.closeAllConnections();
    httpServer.close();
  }

  async function close() {
    await cleanup();
    if (killed) {
      await Promise.allSettled([db.destroy(), redis.quit()]);
      return;
    }
    if (shutDown) {
      await exitCode;
      await Promise.allSettled([db.destroy(), redis.quit(), ...(adapterClients ?? []).map((c) => c.quit())]);
      return;
    }
    await new Promise<void>((r) => io.close(() => r()));
    await new Promise<void>((r) => httpServer.close(() => r()));
    await Promise.allSettled([db.destroy(), redis.quit(), ...(adapterClients ?? []).map((c) => c.quit())]);
  }

  return {
    url, deps, db, pool, redis, presence, realtime, rides, io, http,
    registerDriver, registerStand, approvedDriver, approvedStand,
    adminToken, adminAction, loginDriver, loginStand,
    socket, connectOk, connectError, cleanup, close, kill, shutdown, httpServer,
  };
}
