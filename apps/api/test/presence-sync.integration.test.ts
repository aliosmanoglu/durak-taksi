// Şoför varlık senkronu: `offlineReason`, `presenceVersion`, `session_sync_request` (CLAUDE.md Bölüm 6).
// Gerçek PostGIS + Redis (testcontainers); mock yok. Sweeper worker'daki gerçek fonksiyondur
// (API ile worker aynı Redis anahtarlarını paylaşır; bu dosya iki bileşenin sözleşmesini birlikte sınar).
//
// Sözleşme:
// - offlineReason yalnızca `driverStatus === 'offline'` iken bulunur: go_offline → `user`; sweeper →
//   `stale_heartbeat`; askıya alma / POST /auth/logout (forceOffline) → `forced`; hiç aktif olmamış veya
//   hash'i olmayan → `not_online`. go_online reason'ı temizler.
// - presenceVersion her durum geçişinde kesin artar (Redis TIME tabanlı, max(now, eski+1)); hash silinse
//   bile geri gitmez; go_online `busy` dönerse değişmez.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import {
  DRIVER_EVENTS,
  OFFLINE_REASONS,
  PRESENCE,
  redisKeys,
  type Ack,
  type DriverSessionSync,
  type DriverStatusResult,
} from '@duraknet/shared';
import { sweepStaleDrivers } from '../../worker/src/sweeper';
import { startTestApp, type TestApp } from './helpers/app';
import { perMin, withLimits } from './helpers/limits';
import {
  cleanupPresence,
  connectWithSync,
  driverHash,
  heartbeatScore,
  inGeo,
  nextSessionSync,
  sleep,
  SULTANAHMET,
  TAKSIM,
  waitFor,
} from './helpers/presence';

const bearer = (token: string) => `Bearer ${token}`;
const STALE = PRESENCE.HEARTBEAT_STALE_MS;

let t: TestApp;
const touched = new Set<string>();

beforeAll(async () => {
  // Eşzamanlılık testi aynı şoför için çok sayıda go_online/offline gönderir: Faz 5 olay sınırı (20/dk) yükseltilir.
  t = await startTestApp({ ...withLimits({ events: { driver_go_online: perMin(10_000), driver_go_offline: perMin(10_000) } }) });
});
afterEach(async () => {
  await cleanupPresence(t.redis, touched);
  touched.clear();
  await t.cleanup();
});
afterAll(async () => {
  await t?.close();
});

async function driver() {
  const d = await t.approvedDriver();
  touched.add(d.id);
  return d;
}

/** Onaylı şoför + bağlı socket + ilk session_sync. */
async function connectedDriver() {
  const d = await driver();
  const { socket, sync } = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
  return { d, socket, first: await sync };
}

async function goOnline(socket: Socket, location = SULTANAHMET) {
  return (await socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOnline, { location })) as Ack<DriverStatusResult>;
}
async function goOffline(socket: Socket) {
  return (await socket.timeout(5000).emitWithAck(DRIVER_EVENTS.goOffline, {})) as Ack<DriverStatusResult>;
}
async function syncRequest(socket: Socket, payload: unknown = {}) {
  return (await socket.timeout(5000).emitWithAck(DRIVER_EVENTS.sessionSyncRequest, payload)) as Ack<DriverSessionSync>;
}

/** ok:true ack'in verisini döndürür; değilse ack'i gösteren anlamlı bir hata ile düşer. */
function okData<T>(ack: Ack<T>): T {
  expect(ack, `ok:true bekleniyordu: ${JSON.stringify(ack)}`).toMatchObject({ ok: true });
  return (ack as { ok: true; data: T }).data;
}
async function onlineVersion(socket: Socket, location = SULTANAHMET) {
  const data = okData(await goOnline(socket, location));
  expect(data.status).toBe('available');
  expectVersion(data.presenceVersion);
  return data.presenceVersion;
}
async function offlineVersion(socket: Socket) {
  const data = okData(await goOffline(socket));
  expect(data.status).toBe('offline');
  expectVersion(data.presenceVersion);
  return data.presenceVersion;
}
async function currentSync(socket: Socket) {
  const data = okData(await syncRequest(socket));
  expectVersion(data.presenceVersion);
  return data;
}

function expectVersion(v: unknown) {
  expect(typeof v, `presenceVersion sayı olmalı: ${JSON.stringify(v)}`).toBe('number');
  expect(Number.isSafeInteger(v)).toBe(true);
  expect(v as number).toBeGreaterThan(0);
}

/** Tam gövde: fazla alan yok, offlineReason yalnızca offline iken. */
function expectOfflineSync(s: DriverSessionSync, reason: (typeof OFFLINE_REASONS)[number]) {
  expect(s).toEqual({ driverStatus: 'offline', offlineReason: reason, presenceVersion: expect.any(Number), openRequests: [], serverTime: expect.any(String) });
}
function expectOnlineSync(s: DriverSessionSync, status: 'available' | 'busy' = 'available') {
  expect(s).toEqual({ driverStatus: status, presenceVersion: expect.any(Number), openRequests: [], serverTime: expect.any(String) });
  expect(s).not.toHaveProperty('offlineReason');
}

/** Sweeper'ı gerçek zamanlı beklemeden tetikler: şoförün heartbeat skorunu eşiğin ötesine çeker ve taramayı çalıştırır. */
async function sweepDriver(driverId: string) {
  const now = Date.now();
  // XX: yalnızca heartbeat'te zaten varsa (online şoför) skoru güncelle; offline şoföre kayıt eklenmez.
  await t.redis.zadd(redisKeys.heartbeat, 'XX', now - STALE - 10_000, driverId);
  return sweepStaleDrivers(t.redis, { staleMs: STALE, now });
}

// ---------------------------------------------------------------------------------------------------

describe('offlineReason', () => {
  it('not_online: hiç aktif olmamış yeni şoförün ilk bağlantısında session_sync {offline, not_online, presenceVersion}', async () => {
    const { socket, first } = await connectedDriver();
    expectOfflineSync(first, 'not_online');
    expectVersion(first.presenceVersion);

    const again = await currentSync(socket);
    expectOfflineSync(again, 'not_online');
    // Hash yokken sürüm TIME'dan okunur; geri gitmemeli.
    expect(again.presenceVersion).toBeGreaterThanOrEqual(first.presenceVersion);
  });

  it('user: go_offline sonrası session_sync_request ve yeniden bağlanma reason=user; go_online reason\'ı temizler', async () => {
    const { d, socket } = await connectedDriver();
    await onlineVersion(socket);
    const vOff = await offlineVersion(socket);

    const s = await currentSync(socket);
    expectOfflineSync(s, 'user');
    expect(s.presenceVersion).toBe(vOff);

    socket.close();
    const re = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    const reSync = await re.sync;
    expectOfflineSync(reSync, 'user');
    expect(reSync.presenceVersion).toBe(vOff);

    const vOn = await onlineVersion(re.socket);
    const on = await currentSync(re.socket);
    expectOnlineSync(on);
    expect(on.presenceVersion).toBe(vOn);
  });

  it('stale_heartbeat: sweeper düşürdüğünde session_sync_request ve yeniden bağlanma reason=stale_heartbeat', async () => {
    const { d, socket } = await connectedDriver();
    const vOn = await onlineVersion(socket);

    expect(await sweepDriver(d.id)).toContain(d.id);
    expect(await inGeo(t.redis, d.id)).toBe(false);

    const s = await currentSync(socket);
    expectOfflineSync(s, 'stale_heartbeat');
    expect(s.presenceVersion).toBeGreaterThan(vOn);

    socket.close();
    const re = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    const reSync = await re.sync;
    expectOfflineSync(reSync, 'stale_heartbeat');
    expect(reSync.presenceVersion).toBe(s.presenceVersion);
  });

  it('stale_heartbeat: sweeper\'ın düşürdüğü (socket\'i bağlı) şoför konum gönderince session_sync reason + sürüm taşır', async () => {
    const { d, socket } = await connectedDriver();
    const vOn = await onlineVersion(socket);
    await sweepDriver(d.id);
    const expected = await currentSync(socket);

    const resync = nextSessionSync<DriverSessionSync>(socket);
    socket.emit(DRIVER_EVENTS.locationUpdate, { location: TAKSIM, ts: Date.now() });
    const s = await resync;
    expectOfflineSync(s, 'stale_heartbeat');
    expect(s.presenceVersion).toBe(expected.presenceVersion);
    expect(s.presenceVersion).toBeGreaterThan(vOn);
    expect(await inGeo(t.redis, d.id)).toBe(false);
  });

  it('forced (askıya alma): yeniden onay + giriş sonrası ilk session_sync reason=forced, sürüm online\'dan büyük', async () => {
    const { d, socket } = await connectedDriver();
    const vOn = await onlineVersion(socket);
    const disconnected = new Promise<string>((r) => socket.once('disconnect', (reason) => r(reason)));

    await t.adminAction('drivers', d.id, 'suspend');
    expect(await disconnected).toBe('io server disconnect');
    expect(await inGeo(t.redis, d.id)).toBe(false);

    await t.adminAction('drivers', d.id, 'approve');
    const login = await t.loginDriver(d.phone.e164);
    expect(login.status).toBe(200);
    const re = connectWithSync<DriverSessionSync>(t, '/driver', login.body.data.accessToken as string);
    const s = await re.sync;
    expectOfflineSync(s, 'forced');
    expect(s.presenceVersion).toBeGreaterThan(vOn);
  });

  it('forced (POST /auth/logout): yeniden giriş sonrası session_sync ve session_sync_request reason=forced', async () => {
    const { d, socket } = await connectedDriver();
    const vOn = await onlineVersion(socket);

    const res = await t.http().post('/auth/logout').set('Authorization', bearer(d.tokens.accessToken));
    expect(res.status).toBe(200);
    expect(await inGeo(t.redis, d.id)).toBe(false);

    const login = await t.loginDriver(d.phone.e164);
    expect(login.status).toBe(200);
    const re = connectWithSync<DriverSessionSync>(t, '/driver', login.body.data.accessToken as string);
    const s = await re.sync;
    expectOfflineSync(s, 'forced');
    expect(s.presenceVersion).toBeGreaterThan(vOn);

    const req = await currentSync(re.socket);
    expectOfflineSync(req, 'forced');
    expect(req.presenceVersion).toBe(s.presenceVersion);
  });

  it('forced (forceOffline, socket bağlı kalır): konum gönderince session_sync {offline, forced, sürüm}', async () => {
    const { d, socket } = await connectedDriver();
    const vOn = await onlineVersion(socket);
    await t.presence.forceOffline(d.id);

    const resync = nextSessionSync<DriverSessionSync>(socket);
    socket.emit(DRIVER_EVENTS.locationUpdate, { location: TAKSIM, ts: Date.now() });
    const s = await resync;
    expectOfflineSync(s, 'forced');
    expect(s.presenceVersion).toBeGreaterThan(vOn);
    expect(socket.connected).toBe(true);
  });

  it('not_online (hash TTL ile düşmüş): konum gönderince ve session_sync_request\'te reason=not_online, sürüm geri gitmez; ilk go_online kesin büyük', async () => {
    const { d, socket } = await connectedDriver();
    const vOn = await onlineVersion(socket);
    // TTL ile düşmüş hash'i simüle et: TTL'li varlık kayıtları gider; sürüm anahtarı (TTL yok) kalır.
    await t.redis
      .multi()
      .del(redisKeys.driver(d.id), redisKeys.locationThrottle(d.id))
      .zrem(redisKeys.geoAvailable, d.id)
      .zrem(redisKeys.heartbeat, d.id)
      .exec();

    const resync = nextSessionSync<DriverSessionSync>(socket);
    socket.emit(DRIVER_EVENTS.locationUpdate, { location: TAKSIM, ts: Date.now() });
    const s = await resync;
    expectOfflineSync(s, 'not_online');
    expect(s.presenceVersion).toBeGreaterThanOrEqual(vOn);

    const req = await currentSync(socket);
    expectOfflineSync(req, 'not_online');
    expect(req.presenceVersion).toBeGreaterThanOrEqual(s.presenceVersion);

    const vOn2 = await onlineVersion(socket);
    expect(vOn2).toBeGreaterThan(req.presenceVersion);
    expect(vOn2).toBeGreaterThan(vOn);
  });

  it('tüm varlık anahtarları (sürüm dahil) silinmiş: reason=not_online; ilk go_online okunan sürümden kesin büyük', async () => {
    const { d, socket } = await connectedDriver();
    await onlineVersion(socket);
    await cleanupPresence(t.redis, [d.id]);
    expect(await t.redis.exists(redisKeys.driverPresenceVersion(d.id))).toBe(0);

    const s = await currentSync(socket);
    expectOfflineSync(s, 'not_online');
    // Sürüm anahtarı elle silinince yalnızca Redis saati kalır; önceki sürümle kıyas garanti edilmez.
    const vOn = await onlineVersion(socket);
    expect(vOn).toBeGreaterThan(s.presenceVersion);
  });

  it('yalnızca dn:driver hash\'i DEL edilmiş (heartbeat/GEO kalıntısı var): reason=not_online', async () => {
    const { d, socket } = await connectedDriver();
    await onlineVersion(socket);
    await t.redis.del(redisKeys.driver(d.id));
    expectOfflineSync(await currentSync(socket), 'not_online');
  });
});

describe('presenceVersion', () => {
  it('online → offline → online → sweep zincirinde kesin artar; her ack sonraki session_sync ile aynı', async () => {
    const { d, socket, first } = await connectedDriver();
    const v0 = first.presenceVersion;

    const v1 = await onlineVersion(socket);
    expect(v1).toBeGreaterThanOrEqual(v0);
    expect((await currentSync(socket)).presenceVersion).toBe(v1);

    const v2 = await offlineVersion(socket);
    expect(v2).toBeGreaterThan(v1);
    expect((await currentSync(socket)).presenceVersion).toBe(v2);

    const v3 = await onlineVersion(socket, TAKSIM);
    expect(v3).toBeGreaterThan(v2);
    expect((await currentSync(socket)).presenceVersion).toBe(v3);

    expect(await sweepDriver(d.id)).toContain(d.id);
    const s4 = await currentSync(socket);
    expect(s4.driverStatus).toBe('offline');
    expect(s4.presenceVersion).toBeGreaterThan(v3);

    // Geçiş olmadan tekrar okumak sürümü değiştirmez; yeniden bağlanma aynı sürümü görür.
    expect((await currentSync(socket)).presenceVersion).toBe(s4.presenceVersion);
    socket.close();
    const re = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    expect((await re.sync).presenceVersion).toBe(s4.presenceVersion);
  });

  it('art arda hızlı geçişlerde (aynı milisaniyeye düşebilecek) sürüm yine kesin artar', async () => {
    const { socket } = await connectedDriver();
    const versions: number[] = [];
    for (let i = 0; i < 10; i++) {
      versions.push(await onlineVersion(socket));
      versions.push(await offlineVersion(socket));
    }
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i], `geçiş ${i}: ${JSON.stringify(versions)}`).toBeGreaterThan(versions[i - 1]!);
    }
  });

  it('konum güncellemesi durum geçişi değildir: available şoförün sürümü değişmez', async () => {
    const { d, socket } = await connectedDriver();
    const v1 = await onlineVersion(socket);
    socket.emit(DRIVER_EVENTS.locationUpdate, { location: TAKSIM, ts: Date.now() });
    await waitFor(() => driverHash(t.redis, d.id), (h) => Math.abs(Number(h.lat) - TAKSIM.lat) < 1e-6);
    const s = await currentSync(socket);
    expectOnlineSync(s);
    expect(s.presenceVersion).toBe(v1);
  });

  it('dn:driver hash\'i DEL edildikten sonra okunan sürüm geri gitmez (>=), sonraki go_online kesin büyük', async () => {
    const { d, socket } = await connectedDriver();
    await onlineVersion(socket);
    const vOff = await offlineVersion(socket);
    const vOn = await onlineVersion(socket);
    expect(vOn).toBeGreaterThan(vOff);

    await t.redis.del(redisKeys.driver(d.id));
    const afterDel = await currentSync(socket);
    expect(afterDel.presenceVersion).toBeGreaterThanOrEqual(vOn);

    const vOn2 = await onlineVersion(socket);
    expect(vOn2).toBeGreaterThan(vOn);
    expect(vOn2).toBeGreaterThan(afterDel.presenceVersion);
  });

  it('busy: go_online busy döner ve sürüm değişmez; go_offline INVALID_TRANSITION, sweeper ve konum sürümü değiştirmez', async () => {
    const { d, socket } = await connectedDriver();
    const v1 = await onlineVersion(socket);
    // Faz 3 kabulü yok: busy durumu hash'e doğrudan yazılır (sürüm alanına dokunmadan), GEO'dan çıkarılır.
    await t.redis.hset(redisKeys.driver(d.id), { status: 'busy' });
    await t.redis.zrem(redisKeys.geoAvailable, d.id);

    const busy = await currentSync(socket);
    expectOnlineSync(busy, 'busy');
    expect(busy.presenceVersion).toBe(v1);

    const on = okData(await goOnline(socket, TAKSIM));
    expect(on).toEqual({ status: 'busy', presenceVersion: v1 });

    expect(await goOffline(socket)).toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION' } });

    // busy şoför sweeper'da düşürülmez.
    expect(await sweepDriver(d.id)).not.toContain(d.id);

    // Konum (throttle penceresi dışında) busy şoförün hash'ine yazılır ama geçiş değildir.
    await sleep(PRESENCE.LOCATION_THROTTLE_MS + 100);
    socket.emit(DRIVER_EVENTS.locationUpdate, { location: SULTANAHMET, ts: Date.now() });
    await waitFor(() => driverHash(t.redis, d.id), (h) => Math.abs(Number(h.lat) - SULTANAHMET.lat) < 1e-6);

    const after = await currentSync(socket);
    expectOnlineSync(after, 'busy');
    expect(after.presenceVersion).toBe(v1);
    expect(await inGeo(t.redis, d.id)).toBe(false);
  });
});

describe('PresenceService — sürüm, doğrudan servis çağrılarıyla', () => {
  /** DB'de olmayan rastgele şoför kimliği (yalnızca Redis varlığı). */
  function fakeDriverId() {
    const id = crypto.randomUUID();
    touched.add(id);
    return id;
  }

  it('aynı milisaniyeye yığılan geçişler (pipeline) de kesin artar', async () => {
    const p = t.presence;
    const id = fakeDriverId();
    // Tek bağlantıda art arda gönderilen Lua çağrıları Redis'te aynı ms'ye düşebilir.
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? p.goOnline(id, SULTANAHMET) : p.goOffline(id))),
    );
    const versions = results.map((r) => r.presenceVersion);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i], JSON.stringify(versions)).toBeGreaterThan(versions[i - 1]!);
    }
    expect((await p.getState(id)).presenceVersion).toBe(versions.at(-1));
  });

  it('hash\'i DEL edilen şoförün okunan sürümü geri gitmez (aynı ms\'de silinse bile); ilk go_online kesin büyük', async () => {
    const p = t.presence;
    const id = fakeDriverId();
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? p.goOnline(id, SULTANAHMET) : p.goOffline(id))),
    );
    const last = Math.max(...results.map((r) => r.presenceVersion));
    await t.redis.del(redisKeys.driver(id));
    const s = await p.getState(id);
    expect(s).toMatchObject({ status: 'offline', offlineReason: 'not_online' });
    expect(s.presenceVersion, `son sürüm ${last}, DEL sonrası ${s.presenceVersion}`).toBeGreaterThanOrEqual(last);
    const on = await p.goOnline(id, TAKSIM);
    expect(on.status).toBe('available');
    expect(on.presenceVersion).toBeGreaterThan(last);
    expect(on.presenceVersion).toBeGreaterThan(s.presenceVersion);
  });
});

describe('session_sync_request', () => {
  it('güncel durumu döner (offline → available) ve bağlantıyı koparmaz', async () => {
    const { socket } = await connectedDriver();
    expectOfflineSync(await currentSync(socket), 'not_online');
    const v = await onlineVersion(socket);
    const s = await currentSync(socket);
    expectOnlineSync(s);
    expect(s.presenceVersion).toBe(v);
    expect(socket.connected).toBe(true);
  });

  it('fazla alanlı nesne kabul edilir (alanlar yok sayılır)', async () => {
    const { socket } = await connectedDriver();
    const ack = await syncRequest(socket, { foo: 1 });
    expectOfflineSync(okData(ack), 'not_online');
  });

  it('geçersiz payload → VALIDATION_ERROR; bağlantı açık kalır, durum değişmez', async () => {
    const { socket } = await connectedDriver();
    const v = await onlineVersion(socket);
    for (const bad of [null, 'x', 42, [], true]) {
      const ack = await syncRequest(socket, bad);
      expect(ack, `payload ${JSON.stringify(bad)}`).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    }
    expect(socket.connected).toBe(true);
    const s = await currentSync(socket);
    expectOnlineSync(s);
    expect(s.presenceVersion).toBe(v);
  });
});

describe('eşzamanlılık', () => {
  it('aynı şoför için paralel go_online/go_offline (2 socket) + sweep: son sürüm tüm ack\'lerden ≥, sürümler durumlarla tutarlı', async () => {
    const d = await driver();
    const a = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    const b = connectWithSync<DriverSessionSync>(t, '/driver', d.tokens.accessToken);
    await Promise.all([a.sync, b.sync]);
    const sockets = [a.socket, b.socket];

    const ops: Promise<Ack<DriverStatusResult>>[] = [];
    const sweeps: Promise<string[]>[] = [];
    for (let i = 0; i < 40; i++) {
      const s = sockets[i % 2]!;
      ops.push(i % 3 === 2 ? goOffline(s) : goOnline(s, i % 2 ? TAKSIM : SULTANAHMET));
      if (i % 5 === 0) sweeps.push(sweepDriver(d.id));
    }
    const acks = await Promise.all(ops);
    await Promise.all(sweeps);

    const results = acks.map(okData);
    for (const r of results) {
      expect(['available', 'offline']).toContain(r.status);
      expectVersion(r.presenceVersion);
    }
    // Aynı sürüm tek bir duruma karşılık gelir: farklı durum bildiren iki ack aynı sürümü taşıyamaz.
    const byVersion = new Map<number, Set<string>>();
    for (const r of results) {
      const set = byVersion.get(r.presenceVersion) ?? new Set<string>();
      set.add(r.status);
      byVersion.set(r.presenceVersion, set);
    }
    for (const [v, statuses] of byVersion) {
      expect(statuses.size, `sürüm ${v} birden fazla durumla döndü: ${[...statuses].join(',')}`).toBe(1);
    }

    const maxAck = Math.max(...results.map((r) => r.presenceVersion));
    const final = await currentSync(a.socket);
    expect(final.presenceVersion).toBeGreaterThanOrEqual(maxAck);
    // En yüksek sürümlü ack'ten sonra geçiş olmadıysa son durum o ack'in durumudur.
    if (final.presenceVersion === maxAck) {
      expect(final.driverStatus).toBe(results.find((r) => r.presenceVersion === maxAck)!.status);
    }

    // Son durum kendi içinde tutarlı: available ⇔ GEO'da ⇔ reason yok.
    const geo = await inGeo(t.redis, d.id);
    if (final.driverStatus === 'available') {
      expectOnlineSync(final);
      expect(geo).toBe(true);
      expect(await heartbeatScore(t.redis, d.id)).not.toBeNull();
    } else {
      expect(final.driverStatus).toBe('offline');
      expect(['user', 'stale_heartbeat']).toContain(final.offlineReason);
      expect(geo).toBe(false);
    }

    // Diğer socket aynı sürümü görür (state node/socket'te değil Redis'te).
    expect((await currentSync(b.socket)).presenceVersion).toBe(final.presenceVersion);
  });
});
