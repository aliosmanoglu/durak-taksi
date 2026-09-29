// Entegrasyon testleri için gerçek bağımlılıklarla (PG + Redis) uygulama kurulumu.
// server.ts ile aynı bağlama: Redis store'lu hız sınırlayıcılar, createServer(app) → attach.
import { randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import pino from 'pino';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../../src/app';
import { createAuthLimiters } from '../../src/auth/limits';
import { hashPassword } from '../../src/auth/password';
import type { AuthDeps } from '../../src/auth/service';
import { createDb } from '../../src/db';
import { createRealtime } from '../../src/realtime';

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

export async function startTestApp() {
  const { db, pool } = createDb(inject('pgUrl'));
  const redis = new Redis(inject('redisUrl'), { maxRetriesPerRequest: 1 });
  const log = pino({ level: 'silent' });

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

  const { io, realtime, attach } = createRealtime(deps, log, { corsOrigin: '*' });
  const app = createApp({
    auth: deps,
    realtime,
    authLimiters,
    log,
    corsOrigin: '*',
    // Testler X-Forwarded-For ile farklı istemci IP'leri simüle eder.
    trustProxy: 'loopback',
    readinessChecks: [
      { name: 'postgres', check: async () => void (await pool.query('SELECT 1')) },
      { name: 'redis', check: async () => void (await redis.ping()) },
    ],
  });

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
    };
  }

  async function registerDriver() {
    const phone = uniquePhone();
    const plate = uniquePlate();
    const res = await http()
      .post('/auth/driver/register')
      .send({ fullName: 'Test Şoför', phone: phone.local, password: PASSWORD, plate, licenseNo: 'RUHSAT-1' });
    if (res.status !== 201) throw new Error(`şoför kaydı başarısız: ${res.status} ${JSON.stringify(res.body)}`);
    const id = res.body.data.id as string;
    created.drivers.add(id);
    return { id, phone, plate, status: res.body.data.status as string };
  }

  async function registerStand(location = { lat: 41.0082, lng: 28.9784 }) {
    const username = uniqueUsername();
    const res = await http()
      .post('/auth/stand/register')
      .send({ name: 'Test Durağı', phone: uniquePhone().local, location, username, password: PASSWORD });
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
    const s = connect(`${url}${nsp}`, { reconnection: false, forceNew: true, auth: token ? { token } : {}, ...opts });
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

  async function close() {
    await cleanup();
    await new Promise<void>((r) => io.close(() => r()));
    await new Promise<void>((r) => httpServer.close(() => r()));
    await Promise.allSettled([db.destroy(), redis.quit()]);
  }

  return {
    url, deps, db, pool, redis, http,
    registerDriver, registerStand, approvedDriver, approvedStand,
    adminToken, adminAction, loginDriver, loginStand,
    socket, connectOk, connectError, cleanup, close,
  };
}
