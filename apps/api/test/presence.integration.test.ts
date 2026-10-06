// Faz 2 (şoför varlığı & konum) entegrasyon testleri — gerçek PostGIS + Redis (testcontainers).
// CLAUDE.md Bölüm 5 Senaryo 1–2, Bölüm 6 (/driver, /stand, session_sync).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DRIVER_EVENTS,
  PRESENCE,
  redisKeys,
  type Ack,
  type DriverSessionSync,
  type DriverStatusResult,
  type StandSessionSync,
} from '@duraknet/shared';
import { AppError } from '../src/http/errors';
import type { LocationResult } from '../src/presence/service';
import { startTestApp, type TestApp } from './helpers/app';
import {
  cleanupPresence,
  connectWithSync,
  createProbe,
  distanceM,
  driverHash,
  geoPos,
  geoSearch,
  heartbeatScore,
  inGeo,
  nextSessionSync,
  sleep,
  SULTANAHMET,
  TAKSIM,
  waitFor,
  wrapPresence,
} from './helpers/presence';

const bearer = (token: string) => `Bearer ${token}`;
/** Throttle Redis anahtarının TTL'ine dayanır (`now`'a değil): pencereyi geçmek için gerçek bekleme gerekir. */
const PAST_THROTTLE_MS = PRESENCE.LOCATION_THROTTLE_MS + 100;

let t: TestApp;
let probe: Awaited<ReturnType<typeof createProbe>>;
/** Testin Redis'te iz bıraktığı şoförler; afterEach'te yalnızca bunlar temizlenir. */
const touched = new Set<string>();

beforeAll(async () => {
  // redis-adapter'lı node: probe, sunucu tarafındaki socket'leri fetchSockets() ile görebilsin.
  t = await startTestApp({ redisAdapter: true });
  probe = await createProbe(t.redis);
});
afterEach(async () => {
  await cleanupPresence(t.redis, touched);
  touched.clear();
  await t.cleanup();
});
afterAll(async () => {
  await probe?.close();
  await t?.close();
});

/** Onaylı şoför açar ve Redis temizliğine kaydeder. */
async function driver(app: TestApp = t) {
  const d = await app.approvedDriver();
  touched.add(d.id);
  return d;
}

/** Yalnızca Redis varlığı gereken servis testleri için rastgele (DB'de olmayan) şoför kimliği. */
function fakeDriverId() {
  const id = crypto.randomUUID();
  touched.add(id);
  return id;
}

async function expectAppError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'hata fırlatılmalıydı').toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
}

/** Socket handler'larının `updateLocation` çağrılarının sonuçlarını sırayla kaydeder. */
function recordLocationResults(app: TestApp = t) {
  const results: LocationResult[] = [];
  const restore = wrapPresence(app.presence, 'updateLocation', (orig) => async (...args) => {
    const r = await orig(...args);
    results.push(r);
    return r;
  });
  return { results, restore };
}

describe('PresenceService — aktif/pasif mod (Senaryo 2)', () => {
  it('1. goOnline → GEOSEARCH (lng,lat) şoförü bulur ve mesafe beklenenle uyumlu; goOffline → bulunmaz, status offline', async () => {
    const p = t.presence;
    const id = fakeDriverId();

    expect((await p.goOnline(id, SULTANAHMET)).status).toBe('available');
    expect(await p.getStatus(id)).toBe('available');

    // GEOPOS (lng, lat) sırasıyla yazıldığını doğrular: ters yazılsaydı lat≈28.97 olurdu.
    const pos = await geoPos(t.redis, id);
    expect(pos).not.toBeNull();
    expect(pos!.lat).toBeCloseTo(SULTANAHMET.lat, 4);
    expect(pos!.lng).toBeCloseTo(SULTANAHMET.lng, 4);

    // Taksim–Sultanahmet ≈ 3.5 km. 4 km'de bulunur, mesafe haversine ile %1 içinde; 3 km'de bulunmaz.
    const expected = distanceM(TAKSIM, SULTANAHMET);
    expect(expected).toBeGreaterThan(3300);
    expect(expected).toBeLessThan(3700);
    const near = await geoSearch(t.redis, TAKSIM, 4000);
    expect(near.has(id)).toBe(true);
    expect(Math.abs(near.get(id)! - expected) / expected).toBeLessThan(0.01);
    expect((await geoSearch(t.redis, TAKSIM, 3000)).has(id)).toBe(false);

    const h = await driverHash(t.redis, id);
    expect(h.status).toBe('available');
    expect(Number(h.lat)).toBeCloseTo(SULTANAHMET.lat, 6);
    expect(Number(h.lng)).toBeCloseTo(SULTANAHMET.lng, 6);
    expect(await heartbeatScore(t.redis, id)).not.toBeNull();

    expect((await p.goOffline(id)).status).toBe('offline');
    expect((await geoSearch(t.redis, TAKSIM, 4000)).has(id)).toBe(false);
    expect(await inGeo(t.redis, id)).toBe(false);
    expect((await driverHash(t.redis, id)).status).toBe('offline');
    expect(await p.getStatus(id)).toBe('offline');
  });

  it('getStatus: hash yoksa offline', async () => {
    expect(await t.presence.getStatus(fakeDriverId())).toBe('offline');
  });

  it('goOnline tekrarı idempotenttir (available kalır, GEO\'da tek kayıt)', async () => {
    const p = t.presence;
    const id = fakeDriverId();
    expect((await p.goOnline(id, SULTANAHMET)).status).toBe('available');
    expect((await p.goOnline(id, TAKSIM)).status).toBe('available');
    const pos = await geoPos(t.redis, id);
    expect(pos!.lat).toBeCloseTo(TAKSIM.lat, 4);
    expect(pos!.lng).toBeCloseTo(TAKSIM.lng, 4);
  });
});

describe('PresenceService — konum güncellemesi (Senaryo 1)', () => {
  it('2. updateLocation hash/GEO/heartbeat\'i günceller (ok); throttle penceresinde ikincisi throttled ve konum değişmez; pencere dışı ok', async () => {
    const p = t.presence;
    const id = fakeDriverId();
    await p.goOnline(id, SULTANAHMET); // sözleşme: goOnline throttle tüketmez

    const t1 = Date.now();
    expect(await p.updateLocation(id, { location: TAKSIM, heading: 90 }, t1)).toBe('ok');

    let h = await driverHash(t.redis, id);
    expect(h.status).toBe('available');
    expect(Number(h.lat)).toBeCloseTo(TAKSIM.lat, 6);
    expect(Number(h.lng)).toBeCloseTo(TAKSIM.lng, 6);
    expect(Number(h.heading)).toBe(90);
    expect(Number(h.updatedAt)).toBe(t1);
    expect(await heartbeatScore(t.redis, id)).toBe(t1);
    const pos = await geoPos(t.redis, id);
    expect(pos!.lat).toBeCloseTo(TAKSIM.lat, 4);
    expect(pos!.lng).toBeCloseTo(TAKSIM.lng, 4);
    // Hash TTL'i (24 saat) her güncellemede yenilenir.
    const ttl = await t.redis.ttl(redisKeys.driver(id));
    expect(ttl).toBeGreaterThan(PRESENCE.DRIVER_HASH_TTL_S - 60);
    expect(ttl).toBeLessThanOrEqual(PRESENCE.DRIVER_HASH_TTL_S);

    // Aynı pencere içinde: throttled, hiçbir şey değişmez.
    expect(await p.updateLocation(id, { location: SULTANAHMET, heading: 180 }, t1 + 500)).toBe('throttled');
    h = await driverHash(t.redis, id);
    expect(Number(h.lat)).toBeCloseTo(TAKSIM.lat, 6);
    expect(Number(h.heading)).toBe(90);
    expect(Number(h.updatedAt)).toBe(t1);
    expect(await heartbeatScore(t.redis, id)).toBe(t1);
    expect((await geoPos(t.redis, id))!.lat).toBeCloseTo(TAKSIM.lat, 4);

    // Pencere dışı (throttle Redis TTL'ine dayanır → gerçek bekleme ≤ 1.1 sn).
    await sleep(PAST_THROTTLE_MS);
    const t2 = Date.now();
    expect(await p.updateLocation(id, { location: SULTANAHMET }, t2)).toBe('ok');
    h = await driverHash(t.redis, id);
    expect(Number(h.lat)).toBeCloseTo(SULTANAHMET.lat, 6);
    expect(Number(h.updatedAt)).toBe(t2);
    expect(await heartbeatScore(t.redis, id)).toBe(t2);
    expect((await geoPos(t.redis, id))!.lat).toBeCloseTo(SULTANAHMET.lat, 4);
  });

  it('throttle şoför başınadır: bir şoförün güncellemesi diğerini kısıtlamaz', async () => {
    const p = t.presence;
    const a = fakeDriverId();
    const b = fakeDriverId();
    await Promise.all([p.goOnline(a, SULTANAHMET), p.goOnline(b, SULTANAHMET)]);
    const now = Date.now();
    expect(await p.updateLocation(a, { location: TAKSIM }, now)).toBe('ok');
    expect(await p.updateLocation(b, { location: TAKSIM }, now)).toBe('ok');
  });

  it('3. offline şoförün konumu yok sayılır: offline döner, GEO\'ya/heartbeat\'e girmez ve throttle tüketmez', async () => {
    const p = t.presence;

    // Hiç online olmamış şoför.
    const never = fakeDriverId();
    expect(await p.updateLocation(never, { location: TAKSIM }, Date.now())).toMatchObject({ status: 'offline', offlineReason: 'not_online' });
    expect(await inGeo(t.redis, never)).toBe(false);
    expect(await heartbeatScore(t.redis, never)).toBeNull();
    expect(await p.getStatus(never)).toBe('offline');
    expect(await t.redis.exists(redisKeys.locationThrottle(never))).toBe(0);
    // Offline güncelleme throttle'ı tüketmediği için online olur olmaz ilk konum kabul edilir.
    await p.goOnline(never, SULTANAHMET);
    expect(await p.updateLocation(never, { location: TAKSIM }, Date.now())).toBe('ok');

    // Online → offline sonrası gelen gecikmiş konum şoförü GEO'ya geri yazmamalı.
    const was = fakeDriverId();
    await p.goOnline(was, SULTANAHMET);
    await p.goOffline(was);
    expect(await p.updateLocation(was, { location: TAKSIM }, Date.now())).toMatchObject({ status: 'offline', offlineReason: 'user' });
    expect(await inGeo(t.redis, was)).toBe(false);
    expect((await driverHash(t.redis, was)).status).toBe('offline');
    expect((await geoSearch(t.redis, TAKSIM, 500)).has(was)).toBe(false);
  });

  it('4. busy şoför: konum hash/heartbeat\'e yazılır (ok) ama GEO\'ya girmez; goOnline busy döner; goOffline INVALID_TRANSITION', async () => {
    const p = t.presence;
    const id = fakeDriverId();
    // Faz 3 (kabul) yok: busy durumu doğrudan hash'e yazılır.
    await t.redis.hset(redisKeys.driver(id), { status: 'busy', lat: String(SULTANAHMET.lat), lng: String(SULTANAHMET.lng) });

    const now = Date.now();
    expect(await p.updateLocation(id, { location: TAKSIM, heading: 45 }, now)).toBe('ok');
    const h = await driverHash(t.redis, id);
    expect(h.status).toBe('busy');
    expect(Number(h.lat)).toBeCloseTo(TAKSIM.lat, 6);
    expect(Number(h.lng)).toBeCloseTo(TAKSIM.lng, 6);
    expect(Number(h.updatedAt)).toBe(now);
    expect(await heartbeatScore(t.redis, id)).toBe(now);
    expect(await inGeo(t.redis, id)).toBe(false);

    expect((await p.goOnline(id, TAKSIM)).status).toBe('busy');
    expect(await inGeo(t.redis, id)).toBe(false);
    expect(await p.getStatus(id)).toBe('busy');

    await expectAppError(p.goOffline(id), 'INVALID_TRANSITION');
    expect(await p.getStatus(id)).toBe('busy');
  });

  it('4b. busy şoför socket\'ten driver_go_offline gönderirse INVALID_TRANSITION ack\'i alır, busy kalır', async () => {
    const d = await driver();
    await t.redis.hset(redisKeys.driver(d.id), { status: 'busy' });
    const { socket, sync } = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    expect((await sync).driverStatus).toBe('busy');

    const ack = (await socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOffline, {})) as Ack<DriverStatusResult>;
    expect(ack).toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION' } });
    expect((await driverHash(t.redis, d.id)).status).toBe('busy');

    const on = (await socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOnline, { location: TAKSIM })) as Ack<DriverStatusResult>;
    expect(on).toEqual({ ok: true, data: { status: 'busy', presenceVersion: expect.any(Number) } });
    expect(await inGeo(t.redis, d.id)).toBe(false);
  });
});

describe('Socket — /driver ve /stand', () => {
  it('5a. bağlanınca session_sync: şoför {driverStatus: offline, openRequests: []}, durak {activeRides: []}', async () => {
    const d = await driver();
    const s = await t.approvedStand();

    const drv = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    const std = connectWithSync<StandSessionSync>(t, '/stand', s.tokens.accessToken);
    expect(await drv.sync).toEqual({ driverStatus: 'offline', offlineReason: 'not_online', presenceVersion: expect.any(Number), openRequests: [], serverTime: expect.any(String) });
    expect(await std.sync).toEqual({ activeRides: [], serverTime: expect.any(String) });
  });

  it('5b. go_online ack\'i available; sunucu kopmayı işledikten sonra presence yerinde; yeniden bağlanınca session_sync available', async () => {
    const d = await driver();
    const first = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    await first.sync;

    const ack = (await first.socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOnline, { location: SULTANAHMET })) as Ack<DriverStatusResult>;
    expect(ack).toEqual({ ok: true, data: { status: 'available', presenceVersion: expect.any(Number) } });
    expect((await geoSearch(t.redis, SULTANAHMET, 100)).has(d.id)).toBe(true);
    const hbBefore = await heartbeatScore(t.redis, d.id);
    expect(hbBefore).not.toBeNull();
    expect(await probe.driverConnected(d.id)).toBe(true);

    first.socket.close();
    // Sunucu socket'i odadan çıkardığında disconnect işlenmiştir (sabit bekleme yerine).
    await waitFor(() => probe.driverConnected(d.id), (x) => x === false);
    expect(await inGeo(t.redis, d.id)).toBe(true);
    expect((await driverHash(t.redis, d.id)).status).toBe('available');
    expect(await heartbeatScore(t.redis, d.id)).toBe(hbBefore);

    const second = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    expect(await second.sync).toEqual({ driverStatus: 'available', presenceVersion: expect.any(Number), openRequests: [], serverTime: expect.any(String) });

    const off = (await second.socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOffline, {})) as Ack<DriverStatusResult>;
    expect(off).toEqual({ ok: true, data: { status: 'offline', presenceVersion: expect.any(Number) } });
    expect(await inGeo(t.redis, d.id)).toBe(false);
  });

  it('5c. geçersiz driver_go_online payload\'ı VALIDATION_ERROR ack\'i alır; şoför GEO\'ya girmez', async () => {
    const d = await driver();
    const { socket, sync } = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    await sync;

    for (const bad of [{}, { location: { lat: 200, lng: 0 } }, { location: { lat: '41', lng: '29' } }, null]) {
      const ack = (await socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOnline, bad)) as Ack;
      expect(ack).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    }
    expect(await inGeo(t.redis, d.id)).toBe(false);
    expect(await t.presence.getStatus(d.id)).toBe('offline');
    expect(socket.connected).toBe(true);
  });

  it('5d. ack\'siz driver_location_update Redis\'e yansır; geçersiz payload servise hiç ulaşmaz', async () => {
    const d = await driver();
    const { socket, sync } = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    await sync;
    const on = (await socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOnline, { location: SULTANAHMET })) as Ack;
    expect(on.ok).toBe(true);

    const rec = recordLocationResults();
    try {
      socket.emit(DRIVER_EVENTS.locationUpdate, { location: { lat: 41.1111, lng: 29.1111 } }); // ts yok → geçersiz
      socket.emit(DRIVER_EVENTS.locationUpdate, { location: TAKSIM, heading: 270, ts: Date.now() });

      await waitFor(async () => rec.results.length, (n) => n >= 1);
      const h = await waitFor(
        () => driverHash(t.redis, d.id),
        (x) => Math.abs(Number(x.lat) - TAKSIM.lat) < 1e-6,
      );
      expect(rec.results).toEqual(['ok']); // geçersiz olan servise ulaşmadı
      expect(Number(h.lng)).toBeCloseTo(TAKSIM.lng, 6);
      expect(Number(h.heading)).toBe(270);
      const pos = await geoPos(t.redis, d.id);
      expect(pos!.lat).toBeCloseTo(TAKSIM.lat, 4);
      expect(pos!.lng).toBeCloseTo(TAKSIM.lng, 4);
      expect(Math.abs((await heartbeatScore(t.redis, d.id))! - Date.now())).toBeLessThan(5000);
      expect(socket.connected).toBe(true);
    } finally {
      rec.restore();
    }
  });

  it('5e. throttle socket üzerinden: aynı saniyedeki ikinci konum işlenir ama throttled; pencere dışı üçüncüsü yazılır', async () => {
    const d = await driver();
    const { socket, sync } = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    await sync;
    await socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOnline, { location: SULTANAHMET });

    const THIRD = { lat: 41.02, lng: 28.99 };
    const rec = recordLocationResults();
    try {
      socket.emit(DRIVER_EVENTS.locationUpdate, { location: TAKSIM, ts: Date.now() });
      socket.emit(DRIVER_EVENTS.locationUpdate, { location: SULTANAHMET, ts: Date.now() });
      // İkinci event'in sunucuda işlendiğinin kanıtı: servis çağrısı döndü ve sonucu throttled.
      await waitFor(async () => rec.results.length, (n) => n >= 2);
      expect(rec.results).toEqual(['ok', 'throttled']);
      expect(Number((await driverHash(t.redis, d.id)).lat)).toBeCloseTo(TAKSIM.lat, 6);

      await sleep(PAST_THROTTLE_MS);
      socket.emit(DRIVER_EVENTS.locationUpdate, { location: THIRD, ts: Date.now() });
      await waitFor(async () => rec.results.length, (n) => n >= 3);
      expect(rec.results).toEqual(['ok', 'throttled', 'ok']);
      const h = await driverHash(t.redis, d.id);
      expect(Number(h.lat)).toBeCloseTo(THIRD.lat, 6);
      expect(Number(h.lng)).toBeCloseTo(THIRD.lng, 6);
    } finally {
      rec.restore();
    }
  });

  it('5f (Ö2). sunucu tarafında offline yapılmış şoförün konum güncellemesi → socket\'e session_sync {driverStatus: offline}', async () => {
    const d = await driver();
    const { socket, sync } = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    await sync;
    await socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOnline, { location: SULTANAHMET });
    expect(await inGeo(t.redis, d.id)).toBe(true);

    // Sweeper'ın yaptığı gibi socket'e dokunmadan Redis'te offline yap.
    await t.presence.forceOffline(d.id);

    const resync = nextSessionSync<DriverSessionSync>(socket);
    socket.emit(DRIVER_EVENTS.locationUpdate, { location: TAKSIM, ts: Date.now() });
    expect(await resync).toEqual({ driverStatus: 'offline', offlineReason: 'forced', presenceVersion: expect.any(Number), openRequests: [], serverTime: expect.any(String) });
    expect(await inGeo(t.redis, d.id)).toBe(false);
    expect(socket.connected).toBe(true);
  });

  it('5g (Ö2). hash\'i tamamen silinmiş (TTL) şoförün konumu da session_sync offline tetikler', async () => {
    const d = await driver();
    const { socket, sync } = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    await sync;
    await socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOnline, { location: SULTANAHMET });
    await cleanupPresence(t.redis, [d.id]);

    const resync = nextSessionSync<DriverSessionSync>(socket);
    socket.emit(DRIVER_EVENTS.locationUpdate, { location: TAKSIM, ts: Date.now() });
    expect(await resync).toEqual({ driverStatus: 'offline', offlineReason: 'not_online', presenceVersion: expect.any(Number), openRequests: [], serverTime: expect.any(String) });
    expect(await inGeo(t.redis, d.id)).toBe(false);
  });

  it('5h. online şoförün kabul edilen/throttle\'a takılan konumu session_sync tetiklemez', async () => {
    const d = await driver();
    const { socket, sync } = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    await sync;
    await socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOnline, { location: SULTANAHMET });
    let extra = 0;
    socket.on('session_sync', () => void extra++);
    const rec = recordLocationResults();
    try {
      socket.emit(DRIVER_EVENTS.locationUpdate, { location: TAKSIM, ts: Date.now() });
      socket.emit(DRIVER_EVENTS.locationUpdate, { location: TAKSIM, ts: Date.now() });
      await waitFor(async () => rec.results.length, (n) => n >= 2);
      // session_sync, sonuçtan sonra aynı handler'da gönderilirdi; bir ack'li gidiş-dönüş sırayı garanti eder.
      await socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOnline, { location: TAKSIM });
      expect(rec.results).toEqual(['ok', 'throttled']);
      expect(extra).toBe(0);
    } finally {
      rec.restore();
    }
  });
});

describe('hesap kapatma → GEO\'dan anında çıkış (forceOffline)', () => {
  it('6a. admin askıya alınca şoför GEO\'dan ve heartbeat\'ten çıkar, status offline', async () => {
    const d = await driver();
    await t.presence.goOnline(d.id, SULTANAHMET);
    expect(await inGeo(t.redis, d.id)).toBe(true);

    await t.adminAction('drivers', d.id, 'suspend');
    expect(await inGeo(t.redis, d.id)).toBe(false);
    expect(await heartbeatScore(t.redis, d.id)).toBeNull();
    expect((await driverHash(t.redis, d.id)).status ?? 'offline').toBe('offline');
  });

  it('6b. askıya alma busy şoförü de GEO\'dan/heartbeat\'ten çıkarır ve offline yapar', async () => {
    const d = await driver();
    await t.redis.hset(redisKeys.driver(d.id), { status: 'busy' });
    await t.redis.zadd(redisKeys.heartbeat, Date.now(), d.id);

    await t.adminAction('drivers', d.id, 'suspend');
    expect(await heartbeatScore(t.redis, d.id)).toBeNull();
    expect((await driverHash(t.redis, d.id)).status ?? 'offline').toBe('offline');
  });

  it('6c. POST /auth/logout sonrası şoför GEO\'da yok', async () => {
    const d = await driver();
    await t.presence.goOnline(d.id, SULTANAHMET);
    expect(await inGeo(t.redis, d.id)).toBe(true);

    const res = await t.http().post('/auth/logout').set('Authorization', bearer(d.tokens.accessToken));
    expect(res.status).toBe(200);
    expect(await inGeo(t.redis, d.id)).toBe(false);
    expect(await heartbeatScore(t.redis, d.id)).toBeNull();
    expect((await driverHash(t.redis, d.id)).status ?? 'offline').toBe('offline');
  });
});

describe('askıya alma yarışları (Ö1)', () => {
  it('6d. go_online işlenirken (durum kontrolünden sonra, Redis yazımından önce) admin suspend tamamlanır → şoför GEO\'da kalmaz', async () => {
    const d = await driver();
    const { socket, sync } = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    await sync;
    const disconnected = new Promise<string>((r) => socket.once('disconnect', (reason) => r(reason)));

    let origDone!: () => void;
    const goOnlineWritten = new Promise<void>((r) => (origDone = r));
    const restore = wrapPresence(t.presence, 'goOnline', (orig) => async (...args) => {
      // PG commit + forceOffline + disconnectAccount bitsin; ardından eski (yarışı kaybeden) yazım gelsin.
      await t.adminAction('drivers', d.id, 'suspend');
      try {
        return await orig(...args);
      } finally {
        origDone();
      }
    });
    try {
      // Suspend socket'i hemen keser; ack'in gelmesi garanti değildir (kopunca istemci ack'i reddeder).
      const ack = (await socket
        .timeout(5000)
        .emitWithAck(DRIVER_EVENTS.goOnline, { location: SULTANAHMET })
        .catch(() => null)) as Ack | null;
      if (ack) expect(ack).toMatchObject({ ok: false, error: { code: 'ACCOUNT_SUSPENDED' } });
      expect(await disconnected).toBe('io server disconnect');

      await goOnlineWritten;
      // Handler goOnline'dan sonra hesap durumunu yeniden kontrol edip forceOffline yapmalı.
      await waitFor(() => inGeo(t.redis, d.id), (x) => x === false);
      expect(await heartbeatScore(t.redis, d.id)).toBeNull();
      expect(await t.presence.getStatus(d.id)).toBe('offline');
    } finally {
      restore();
    }
  });

  it('6e. aynı yarış, disconnectAccount yayını kaçırılmış (yalnızca DB\'de askı): ack ACCOUNT_SUSPENDED, socket kopar, GEO\'da yok', async () => {
    const d = await driver();
    const { socket, sync } = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    await sync;
    const disconnected = new Promise<string>((r) => socket.once('disconnect', (reason) => r(reason)));

    const restore = wrapPresence(t.presence, 'goOnline', (orig) => async (...args) => {
      await t.db.updateTable('drivers').set({ status: 'suspended' }).where('id', '=', d.id).execute();
      return orig(...args);
    });
    try {
      const ack = (await socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOnline, { location: SULTANAHMET })) as Ack;
      expect(ack).toMatchObject({ ok: false, error: { code: 'ACCOUNT_SUSPENDED' } });
      expect(await disconnected).toBe('io server disconnect');
      expect(await inGeo(t.redis, d.id)).toBe(false);
      expect(await heartbeatScore(t.redis, d.id)).toBeNull();
      expect(await t.presence.getStatus(d.id)).toBe('offline');
    } finally {
      restore();
    }
  });

  it('6f. location_update işlenirken admin suspend tamamlanır → konum GEO\'ya yazılmaz (offline)', async () => {
    const d = await driver();
    const { socket, sync } = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    await sync;
    await socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOnline, { location: SULTANAHMET });

    const results: LocationResult[] = [];
    const restore = wrapPresence(t.presence, 'updateLocation', (orig) => async (...args) => {
      await t.adminAction('drivers', d.id, 'suspend');
      const r = await orig(...args);
      results.push(r);
      return r;
    });
    try {
      socket.emit(DRIVER_EVENTS.locationUpdate, { location: TAKSIM, ts: Date.now() });
      await waitFor(async () => results.length, (n) => n >= 1);
      expect(results).toMatchObject([{ status: 'offline', offlineReason: 'forced' }]);
      expect(await inGeo(t.redis, d.id)).toBe(false);
      expect(await heartbeatScore(t.redis, d.id)).toBeNull();
      expect(await t.presence.getStatus(d.id)).toBe('offline');
    } finally {
      restore();
    }
  });
});

describe('iki API node (redis-adapter)', () => {
  let a: TestApp;
  let b: TestApp;
  beforeAll(async () => {
    [a, b] = await Promise.all([startTestApp({ redisAdapter: true }), startTestApp({ redisAdapter: true })]);
  });
  afterAll(async () => {
    await Promise.allSettled([a?.close(), b?.close()]);
  });

  it('7. şoför node B\'ye bağlı, node A\'dan admin suspend → B\'deki socket kopar ve GEO\'dan çıkar', async () => {
    const d = await driver(a);
    try {
      const { socket, sync } = connectWithSync<DriverSessionSync>(b, '/driver', d.tokens.accessToken);
      await sync;
      const on = (await socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOnline, { location: SULTANAHMET })) as Ack;
      expect(on.ok).toBe(true);
      const disconnected = new Promise<string>((r) => socket.once('disconnect', (reason) => r(reason)));

      await a.adminAction('drivers', d.id, 'suspend');
      const reason = await Promise.race([disconnected, sleep(5000).then(() => 'zaman aşımı: socket kopmadı')]);
      expect(reason).toBe('io server disconnect');
      expect(await inGeo(a.redis, d.id)).toBe(false);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('7b. node A\'da go_online, node B\'de yeniden bağlanma → session_sync available (state node\'da değil Redis\'te)', async () => {
    const d = await driver(a);
    try {
      const first = connectWithSync<DriverSessionSync>(a, '/driver', d.tokens.accessToken);
      await first.sync;
      await first.socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOnline, { location: SULTANAHMET });
      first.socket.close();

      const second = connectWithSync<DriverSessionSync>(b, '/driver', d.tokens.accessToken);
      expect(await second.sync).toEqual({ driverStatus: 'available', presenceVersion: expect.any(Number), openRequests: [], serverTime: expect.any(String) });
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('7c. node A\'dan fetchSockets node B\'deki socket\'i görür (socket.data serileştirilebilir)', async () => {
    const d = await driver(a);
    try {
      const { sync } = connectWithSync<DriverSessionSync>(b, '/driver', d.tokens.accessToken);
      await sync;
      // Oturum zamanlayıcıları socket.data'da olsaydı B'nin yanıtı JSON'a çevrilemez, A zaman aşımına düşerdi.
      const remote = await a.io.of('/driver').in(`driver:${d.id}`).timeout(5000).fetchSockets();
      expect(remote).toHaveLength(1);
      expect((remote[0]!.data as { auth: { sub: string } }).auth.sub).toBe(d.id);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});
