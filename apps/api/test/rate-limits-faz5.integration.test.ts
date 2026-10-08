// Faz 5 hız sınırları (docs/design/faz5-resilience.md Bölüm 2). Gerçek 600/dk'yı doldurmak yerine düşük limit override'ı
// ile koşar. Mevcut kimlik limitleri rate-limit.integration.test.ts'te.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DRIVER_EVENTS, redisKeys, STAND_EVENTS } from '@duraknet/shared';
import { randomIp, startTestApp, type TestApp } from './helpers/app';
import { perMin, withLimits } from './helpers/limits';
import { startRideApp, type RideApp } from './helpers/ride-app';
import { emitAck, errCode, Scope, sleep, uniqueCity, waitFor } from './helpers/rides';

const bearer = (t: string) => `Bearer ${t}`;

describe('REST genel (IP) ve hesap sınırları', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ ...withLimits({ restIp: perMin(8), restAccount: perMin(4) }) });
  });
  afterEach(() => t.cleanup());
  afterAll(() => t.close());

  it('IP sınırı: aynı IP\'den limit aşılınca 429 RATE_LIMITED; başka IP etkilenmez; /health muaf', async () => {
    const ip = randomIp();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await t.http(ip).get('/me')).status); // kimliksiz: 401 ama sayılır
    expect(statuses.slice(0, 8).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(9)).toEqual([429, 429, 429]);
    const blocked = await t.http(ip).get('/me');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });

    expect((await t.http(randomIp()).get('/me')).status).toBe(401);
    // Sağlık uçları limitten muaf: orkestratör probe'ları hiç engellenmemeli.
    for (let i = 0; i < 15; i++) {
      expect((await t.http(ip).get('/health')).status, `health ${i}`).toBe(200);
      expect((await t.http(ip).get('/ready')).status, `ready ${i}`).toBe(200);
    }
  });

  it('hesap sınırı: aynı hesap farklı IP\'lerden limit aşınca 429; başka hesap etkilenmez', async () => {
    const a = await t.approvedDriver();
    const b = await t.approvedDriver();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      codes.push((await t.http(randomIp()).get('/me').set('Authorization', bearer(a.tokens.accessToken))).status);
    }
    expect(codes.slice(0, 4).every((c) => c === 200)).toBe(true);
    expect(codes.slice(4).every((c) => c === 429)).toBe(true);
    const ok = await t.http(randomIp()).get('/me').set('Authorization', bearer(b.tokens.accessToken));
    expect(ok.status).toBe(200);
  });
});

describe('socket olay sınırı', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({
      ...withLimits({ events: { session_sync_request: perMin(3), driver_go_online: perMin(2), driver_go_offline: perMin(2) } }),
    });
  });
  afterEach(() => t.cleanup());
  afterAll(() => t.close());

  const pos = { lat: 41.0, lng: 29.0 };

  it('limit aşılınca ack RATE_LIMITED; sayaç Redis\'te pencere TTL\'li; anahtar silinince yeniden çalışır', async () => {
    const d = await t.approvedDriver();
    const sock = await t.connectOk('/driver', d.tokens.accessToken);
    for (let i = 0; i < 3; i++) {
      const ack = await emitAck(sock, DRIVER_EVENTS.sessionSyncRequest, {});
      expect(ack.ok, `istek ${i + 1}`).toBe(true);
    }
    const blocked = await emitAck(sock, DRIVER_EVENTS.sessionSyncRequest, {});
    expect(errCode(blocked)).toBe('RATE_LIMITED');

    const key = redisKeys.eventRateLimit('session_sync_request', d.id);
    const ttl = await t.redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);

    await t.redis.del(key); // pencere dolmuş gibi
    expect((await emitAck(sock, DRIVER_EVENTS.sessionSyncRequest, {})).ok).toBe(true);
  });

  it('sınır hesap bazlıdır: başka şoför ve başka olay etkilenmez', async () => {
    const a = await t.approvedDriver();
    const b = await t.approvedDriver();
    const sa = await t.connectOk('/driver', a.tokens.accessToken);
    const sb = await t.connectOk('/driver', b.tokens.accessToken);
    for (let i = 0; i < 3; i++) await emitAck(sa, DRIVER_EVENTS.sessionSyncRequest, {});
    expect(errCode(await emitAck(sa, DRIVER_EVENTS.sessionSyncRequest, {}))).toBe('RATE_LIMITED');
    expect((await emitAck(sb, DRIVER_EVENTS.sessionSyncRequest, {})).ok).toBe(true);
    // Aynı hesabın başka olayı kendi sayacında.
    expect((await emitAck(sa, DRIVER_EVENTS.goOnline, { location: pos })).ok).toBe(true);
  });

  it('driver_go_online/offline sınırı; reddedilen çağrı durumu değiştirmez', async () => {
    const d = await t.approvedDriver();
    const sock = await t.connectOk('/driver', d.tokens.accessToken);
    expect((await emitAck(sock, DRIVER_EVENTS.goOnline, { location: pos })).ok).toBe(true);
    expect((await emitAck(sock, DRIVER_EVENTS.goOnline, { location: pos })).ok).toBe(true);
    expect(errCode(await emitAck(sock, DRIVER_EVENTS.goOnline, { location: pos }))).toBe('RATE_LIMITED');
    expect((await emitAck(sock, DRIVER_EVENTS.goOffline, {})).ok).toBe(true);
    expect((await emitAck(sock, DRIVER_EVENTS.goOffline, {})).ok).toBe(true);
    expect(errCode(await emitAck(sock, DRIVER_EVENTS.goOffline, {}))).toBe('RATE_LIMITED');
    expect((await t.redis.hget(redisKeys.driver(d.id), 'status'))).toBe('offline');
  });

  it('konum güncellemesi olay limitine tabi değildir; 1/sn throttle bozulmaz', async () => {
    const d = await t.approvedDriver();
    const sock = await t.connectOk('/driver', d.tokens.accessToken);
    expect((await emitAck(sock, DRIVER_EVENTS.goOnline, { location: pos })).ok).toBe(true);
    // Hızlı art arda 6 güncelleme: ilki işlenir, aynı saniyedekiler throttle'a takılır (hata/ack yok).
    const next = { lat: 41.01, lng: 29.01 };
    for (let i = 0; i < 6; i++) sock.emit(DRIVER_EVENTS.locationUpdate, { location: { lat: 41.0 + i / 1000, lng: 29.0 }, ts: Date.now() });
    await sleep(300);
    const first = Number(await t.redis.hget(redisKeys.driver(d.id), 'lat'));
    expect(first).toBeGreaterThanOrEqual(41.0);
    expect(first).toBeLessThan(41.003); // en geç 1-2 güncelleme işlendi; 6'sı değil
    // Throttle penceresi geçince yeni güncelleme işlenir (limiter yüzünden engellenmez).
    await sleep(1200);
    sock.emit(DRIVER_EVENTS.locationUpdate, { location: next, ts: Date.now() });
    await waitFor(async () => Number(await t.redis.hget(redisKeys.driver(d.id), 'lat')), (v) => Math.abs(v - next.lat) < 1e-6, 3000);
  });

  it('Redis hatasında fail-open: limitleyici bozulursa olay yine işlenir ve hata sayacı artar', async () => {
    const d = await t.approvedDriver();
    const sock = await t.connectOk('/driver', d.tokens.accessToken);
    // Sayaç anahtarını yanlış tipe çevir: INCR WRONGTYPE verir → limitleyici hata alır.
    const key = redisKeys.eventRateLimit('session_sync_request', d.id);
    await t.redis.del(key);
    await t.redis.rpush(key, 'bozuk');
    for (let i = 0; i < 6; i++) {
      const ack = await emitAck(sock, DRIVER_EVENTS.sessionSyncRequest, {});
      expect(ack.ok, `istek ${i + 1} fail-open olmalı`).toBe(true);
    }
    await t.redis.del(key);
    const metrics = await t.http().get('/metrics');
    expect(metrics.status).toBe(200);
    const m = /^duraknet_rate_limit_errors_total\s+(\d+)/m.exec(metrics.text);
    expect(m, 'duraknet_rate_limit_errors_total yok').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1);
  });
});

describe('socket handshake (IP) sınırı', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ ...withLimits({ socketHandshakeIp: perMin(3) }) });
  });
  afterEach(() => t.cleanup());
  afterAll(() => t.close());

  it('aynı IP\'den limit üstü bağlantı reddedilir; başka IP bağlanır', async () => {
    const d = await t.approvedDriver();
    const ip = randomIp();
    const opts = { extraHeaders: { 'X-Forwarded-For': ip } };
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = t.socket('/driver', d.tokens.accessToken, opts);
      results.push(
        await new Promise<string>((res) => {
          s.once('connect', () => res('ok'));
          s.once('connect_error', (e: Error) => res(e.message));
        }),
      );
      s.close();
    }
    expect(results.slice(0, 3)).toEqual(['ok', 'ok', 'ok']);
    expect(results.slice(3)).toEqual(['RATE_LIMITED', 'RATE_LIMITED']);

    const other = t.socket('/driver', d.tokens.accessToken, { extraHeaders: { 'X-Forwarded-For': randomIp() } });
    await new Promise<void>((res, rej) => {
      other.once('connect', () => res());
      other.once('connect_error', (e: Error) => rej(e));
    });
  });
});

describe('ride_create olay sınırı (durak)', () => {
  let t: RideApp;
  let s: Scope;
  beforeAll(async () => {
    t = await startRideApp({ ...withLimits({ events: { ride_create: perMin(2) } }) });
  });
  afterEach(() => s?.cleanup());
  afterAll(() => t.close());

  it('3. çağrı RATE_LIMITED; PG\'de yalnızca 2 ride; sınır sonrası /metrics sayacı artar', async () => {
    s = new Scope(t);
    const stand = await s.stand(uniqueCity());
    const mk = () => emitAck(stand.socket, STAND_EVENTS.rideCreate, { pickup: stand.location, pickupAddress: 'Adres 1' });
    const r1 = await mk();
    const r2 = await mk();
    expect(r1.ok && r2.ok).toBe(true);
    for (const r of [r1, r2]) if (r.ok && r.data) s.rideIds.add((r.data as { rideId: string }).rideId);
    expect(errCode(await mk())).toBe('RATE_LIMITED');
    const rows = await t.db.selectFrom('rides').select('id').where('stand_id', '=', stand.id).execute();
    expect(rows).toHaveLength(2);

    const metrics = await t.http().get('/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toMatch(/duraknet_rate_limited_total\{[^}]*scope="[^"]*"[^}]*\}\s+[1-9]/);
  });
});

const DIRECT_KEY = redisKeys.eventRateLimit('handshake', '127.0.0.1');

describe('handshake IP: sahte X-Forwarded-For limiti atlatamaz', () => {
  const attempt = async (t: TestApp, token: string, headers: Record<string, string>) => {
    const s = t.socket('/driver', token, { extraHeaders: headers });
    const r = await new Promise<string>((res) => {
      s.once('connect', () => res('ok'));
      s.once('connect_error', (e: Error) => res(e.message));
    });
    s.close();
    return r;
  };

  it('trust proxy kapalı: farklı XFF değerleri aynı bağlantı adresi sayacına düşer', async () => {
    const t = await startTestApp({ ...withLimits({ socketHandshakeIp: perMin(3) }), realtimeExtras: { rateLimits: { socketHandshakeIp: perMin(3) }, trustProxy: false } });
    try {
      const d = await t.approvedDriver();
      await t.redis.del(DIRECT_KEY); // paylaşılan Redis: önceki testin 127.0.0.1 sayacı kalmasın
      const results: string[] = [];
      for (let i = 0; i < 5; i++) results.push(await attempt(t, d.tokens.accessToken, { 'X-Forwarded-For': randomIp() }));
      expect(results).toEqual(['ok', 'ok', 'ok', 'RATE_LIMITED', 'RATE_LIMITED']);
    } finally {
      await t.redis.del(DIRECT_KEY);
      await t.close();
    }
  });

  it('trust proxy loopback: XFF içindeki geçersiz değerler bağlantı adresine düşer ve birlikte sayılır', async () => {
    const t = await startTestApp({ ...withLimits({ socketHandshakeIp: perMin(3) }), realtimeExtras: { rateLimits: { socketHandshakeIp: perMin(3) }, trustProxy: 'loopback' } });
    try {
      const d = await t.approvedDriver();
      await t.redis.del(DIRECT_KEY);
      const results: string[] = [];
      for (let i = 0; i < 5; i++) results.push(await attempt(t, d.tokens.accessToken, { 'X-Forwarded-For': `geçersiz-${i}` }));
      expect(results).toEqual(['ok', 'ok', 'ok', 'RATE_LIMITED', 'RATE_LIMITED']);
      // Geçerli ve farklı XFF hâlâ ayrı sayaçtır (güvenilen proxy arkasındaki gerçek istemciler).
      expect(await attempt(t, d.tokens.accessToken, { 'X-Forwarded-For': randomIp() })).toBe('ok');
    } finally {
      await t.redis.del(DIRECT_KEY);
      await t.close();
    }
  });
});
