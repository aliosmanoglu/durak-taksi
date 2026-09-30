// Faz 3 kararları (a) çıkış/kopma/sweeper matched ride'ı bozmaz, (b) askıya alma eşleşmeyi bozar,
// ve session_sync restorasyonu (panel yenileme, şoför yeniden bağlanma) + konum yayını odası.
// CLAUDE.md "Mevcut durum" → Bilinen sınırlar (3).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DRIVER_EVENTS, PRESENCE, redisKeys, RIDE_ROOM_EVENTS, rideDriverLocationSchema, rideRequestSchema,
  rideSnapshotSchema, STAND_EVENTS, type DriverSessionSync, type RideSnapshot, type StandSessionSync,
} from '@duraknet/shared';
import { sweepStaleDrivers } from '../../worker/src/sweeper';
import { startRideApp, type RideApp } from './helpers/ride-app';
import {
  emitAck, north, Scope, sleep, uniqueCity, waitFor,
  type DriverActor, type StandActor,
} from './helpers/rides';

let t: RideApp;
let s: Scope;
beforeAll(async () => {
  t = await startRideApp({ redisAdapter: true });
});
afterEach(async () => {
  await s?.cleanup();
});
afterAll(async () => {
  await t?.close();
});

const forRide = (rideId: string) => (e: { rideId: string }) => e.rideId === rideId;

async function matchRide(stand: StandActor, driver: DriverActor) {
  const { rideId } = await s.createRide(stand);
  await driver.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
  const ack = await emitAck<RideSnapshot>(driver.socket, DRIVER_EVENTS.rideAccept, { rideId });
  if (!ack.ok) throw new Error(`kabul başarısız: ${JSON.stringify(ack)}`);
  await stand.rec.waitFor(STAND_EVENTS.rideMatched, forRide(rideId));
  return { rideId, version: ack.data!.version };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('5. karar (a): çıkış / kopma / sweeper eşleşmiş ride\'ı bozmaz', () => {
  it('logout: ride matched, şoför busy kalır, durağa ride_driver_cancelled gitmez; yeniden girişte session_sync.activeRide ile devam', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId, version } = await matchRide(stand, d);

    const out = await t.http().post('/auth/logout').set(bearer(d.tokens.accessToken));
    expect(out.status).toBe(200);
    await waitFor(async () => d.socket.connected, (c) => !c);

    expect((await s.ride(rideId))?.status).toBe('matched');
    expect((await s.ride(rideId))?.driver_id).toBe(d.id);
    const h = await s.driverHash(d.id);
    expect(h.status).toBe('busy');
    expect(h.rideId).toBe(rideId);
    expect(await s.inGeo(d.id)).toBe(false);
    await sleep(500);
    expect(stand.rec.count(STAND_EVENTS.rideDriverCancelled)).toBe(0);
    expect(stand.rec.count(STAND_EVENTS.rideSearching, (e) => e.rideId === rideId && e.version > version)).toBe(0);

    // Yeniden giriş → session_sync aktif ride'ı taşır.
    const login = await t.loginDriver(d.phone.e164);
    expect(login.status).toBe(200);
    const conn = await s.openDriver(login.body.data.accessToken);
    expect(conn.sync.driverStatus).toBe('busy');
    const active = rideSnapshotSchema.parse(conn.sync.activeRide);
    expect(active.rideId).toBe(rideId);
    expect(active.status).toBe('matched');
    expect(active.driver?.id).toBe(d.id);
    expect(active.version).toBe(version);
    expect(conn.sync.openRequests).toEqual([]);
    // Ride devam eder: şoför tamamlayabilir.
    expect((await emitAck(conn.socket, DRIVER_EVENTS.rideComplete, { rideId, version: active.version })).ok).toBe(true);
    expect((await s.ride(rideId))?.status).toBe('completed');
  }, 40_000);

  it('socket kopması: ride matched, şoför busy; yeniden bağlanınca session_sync.activeRide ve session_sync_request aynı durumu verir', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId } = await matchRide(stand, d);

    d.socket.close();
    await sleep(400);
    expect((await s.ride(rideId))?.status).toBe('matched');
    expect((await s.driverHash(d.id)).status).toBe('busy');
    expect(stand.rec.count(STAND_EVENTS.rideDriverCancelled)).toBe(0);

    const conn = await s.openDriver(d.tokens.accessToken);
    expect(conn.sync.driverStatus).toBe('busy');
    expect(conn.sync.activeRide?.rideId).toBe(rideId);
    const req = await emitAck<DriverSessionSync>(conn.socket, DRIVER_EVENTS.sessionSyncRequest, {});
    expect(req.ok && req.data?.activeRide?.rideId).toBe(rideId);
    expect(req.ok && req.data?.driverStatus).toBe('busy');
  }, 40_000);

  it('sweeper: konumu eşik üstünde bayat olsa da busy (eşleşmiş) şoförü düşürmez; ride ve GEO dışı durum korunur', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const control = await s.driver(north(city, 250)); // kontrol: bayat available şoför düşürülür
    const { rideId } = await matchRide(stand, d);

    const old = Date.now() - PRESENCE.HEARTBEAT_STALE_MS - 30_000;
    await t.redis.zadd(redisKeys.heartbeat, old, d.id);
    await t.redis.zadd(redisKeys.heartbeat, old, control.id);
    const removed = await sweepStaleDrivers(t.redis, { staleMs: PRESENCE.HEARTBEAT_STALE_MS });
    expect(removed).toContain(control.id);
    expect(removed).not.toContain(d.id);
    expect((await s.driverHash(d.id)).status).toBe('busy');
    expect((await s.driverHash(d.id)).rideId).toBe(rideId);
    expect((await s.driverHash(control.id)).status).toBe('offline');
    expect((await s.ride(rideId))?.status).toBe('matched');
  }, 40_000);
});

describe('6. karar (b): askıya alma eşleşmeyi bozar', () => {
  it('ride searching\'e döner, şoför excluded + forced offline, durağa ride_driver_cancelled, arama devam eder ve başka şoför alabilir', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 1000 });
    const a = await s.driver(north(city, 200));
    const b = await s.driver(north(city, 300));
    const { rideId, version } = await matchRide(stand, a);

    await t.adminAction('drivers', a.id, 'suspend');

    // Şoförün bağlantısı kesilir; ride searching'e döner.
    await waitFor(async () => a.socket.connected, (c) => !c);
    await s.waitRideStatus(rideId, 'searching');
    const row = await s.ride(rideId);
    expect(row?.driver_id).toBeNull();
    expect(row?.version).toBeGreaterThan(version);
    expect((await s.rideHash(rideId)).status).toBe('searching');
    expect((await s.rideHash(rideId)).driverId ?? '').toBe('');
    expect(await s.isExcluded(rideId, a.id)).toBe(true);

    // Şoför tamamen offline (forced), GEO'da yok.
    const ah = await waitFor(() => s.driverHash(a.id), (h) => h.status === 'offline');
    expect(ah.offlineReason).toBe('forced');
    expect(ah.rideId ?? '').toBe('');
    expect(await s.inGeo(a.id)).toBe(false);

    // Durak uyarılır, arama sürer.
    const ev = (await stand.rec.waitFor(STAND_EVENTS.rideDriverCancelled, forRide(rideId)))[0];
    expect(ev.plate).toBe(a.plate);
    expect(ev.version).toBeGreaterThan(version);
    const n = stand.rec.count(STAND_EVENTS.rideSearching, forRide(rideId));
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(rideId), { n: n + 2, ms: 10_000 });

    // Askıdaki şoför hiçbir şekilde yeniden bildirilmez; diğer şoför kabul eder.
    expect(a.rec.count(DRIVER_EVENTS.rideRequested, (e) => e.rideId === rideId && e.version > version)).toBe(0);
    await b.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    expect((await emitAck(b.socket, DRIVER_EVENTS.rideAccept, { rideId })).ok).toBe(true);
    expect((await s.ride(rideId))?.driver_id).toBe(b.id);
  }, 60_000);

  it('eşleşmemiş (available) şoförün askıya alınması ride\'lara dokunmaz', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const a = await s.driver(north(city, 200));
    const b = await s.driver(north(city, 300));
    const { rideId } = await matchRide(stand, a);
    await t.adminAction('drivers', b.id, 'suspend');
    await sleep(500);
    expect((await s.ride(rideId))?.status).toBe('matched');
    expect((await s.ride(rideId))?.driver_id).toBe(a.id);
    expect(stand.rec.count(STAND_EVENTS.rideDriverCancelled)).toBe(0);
  }, 40_000);
});

describe('9. session_sync restorasyonu', () => {
  it('şoför: yeniden bağlanınca openRequests açık çağrıları taşır; ride kapanınca (ride_taken) listeden düşer', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const a = await s.driver(north(city, 200));
    const b = await s.driver(north(city, 250));
    const { rideId } = await s.createRide(stand, city, { notes: 'Hastane acil girişi', dropoffAddress: 'Havalimanı' });
    await a.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId));
    await b.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId));

    // b kopup yeniden bağlanır (uygulama arka plandan döndü).
    b.socket.close();
    const conn = await s.openDriver(b.tokens.accessToken);
    expect(conn.sync.driverStatus).toBe('available');
    expect(conn.sync.activeRide).toBeUndefined();
    expect(conn.sync.openRequests).toHaveLength(1);
    const req = rideRequestSchema.parse(conn.sync.openRequests[0]);
    expect(req.rideId).toBe(rideId);
    expect(req.notes).toBe('Hastane acil girişi');
    expect(req.dropoffAddress).toBe('Havalimanı');
    expect(req.distanceM).toBeGreaterThan(0);
    // Bağlıyken session_sync_request aynı şeyi verir.
    const r = await emitAck<DriverSessionSync>(conn.socket, DRIVER_EVENTS.sessionSyncRequest, {});
    expect(r.ok && r.data?.openRequests.map((x) => x.rideId)).toEqual([rideId]);

    // a kabul eder → b için çağrı kapanır.
    expect((await emitAck(a.socket, DRIVER_EVENTS.rideAccept, { rideId })).ok).toBe(true);
    await conn.rec.waitFor(DRIVER_EVENTS.rideTaken, forRide(rideId));
    const r2 = await emitAck<DriverSessionSync>(conn.socket, DRIVER_EVENTS.sessionSyncRequest, {});
    expect(r2.ok && r2.data?.openRequests).toEqual([]);
    // Yeniden bağlanan kazanan: activeRide dolu, openRequests boş.
    a.socket.close();
    const ac = await s.openDriver(a.tokens.accessToken);
    expect(ac.sync.driverStatus).toBe('busy');
    expect(ac.sync.activeRide?.rideId).toBe(rideId);
    expect(ac.sync.openRequests).toEqual([]);
  }, 40_000);

  it('şoför: durak iptal edince açık çağrı session_sync\'ten düşer', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const a = await s.driver(north(city, 200));
    const { rideId } = await s.createRide(stand);
    await a.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId));
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(rideId));
    expect((await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version: s.lastVersion(stand.rec, rideId) })).ok).toBe(true);
    await a.rec.waitFor(DRIVER_EVENTS.rideTaken, forRide(rideId));
    a.socket.close();
    const conn = await s.openDriver(a.tokens.accessToken);
    expect(conn.sync.openRequests).toEqual([]);
  }, 30_000);

  it('panel yenileme: durak yeniden bağlanınca activeRides searching → matched (şoförle) → iptalden sonra boş', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    expect(stand.sync.activeRides).toEqual([]);

    const { rideId } = await s.createRide(stand);
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId));
    // Yenile #1: searching.
    let panel = await s.openStand(stand.tokens.accessToken);
    let sync: StandSessionSync = panel.sync;
    expect(sync.activeRides).toHaveLength(1);
    let snap = rideSnapshotSchema.parse(sync.activeRides[0]);
    expect(snap.rideId).toBe(rideId);
    expect(snap.status).toBe('searching');
    expect(snap.driver).toBeUndefined();
    expect(snap.stand.id).toBe(stand.id);
    expect(snap.pickup.lat).toBeCloseTo(city.lat, 5);

    // Yenile #2: matched + şoför bilgisi.
    const acc = await emitAck<RideSnapshot>(d.socket, DRIVER_EVENTS.rideAccept, { rideId });
    expect(acc.ok).toBe(true);
    panel = await s.openStand(stand.tokens.accessToken);
    sync = panel.sync;
    expect(sync.activeRides).toHaveLength(1);
    snap = rideSnapshotSchema.parse(sync.activeRides[0]);
    expect(snap.status).toBe('matched');
    expect(snap.driver?.id).toBe(d.id);
    expect(snap.driver?.plate).toBe(d.plate);
    expect(snap.matchedAt).toBeTruthy();

    // İptalden sonra boş.
    const cancel = await emitAck(panel.socket, STAND_EVENTS.rideCancel, { rideId, version: snap.version });
    expect(cancel.ok).toBe(true);
    panel = await s.openStand(stand.tokens.accessToken);
    expect(panel.sync.activeRides).toEqual([]);
  }, 40_000);

  it('panel yenileme: yalnızca kendi durağının çağrıları gelir', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const a = await s.stand(city);
    const b = await s.stand(north(city, 40));
    const { rideId } = await s.createRide(a);
    const panelB = await s.openStand(b.tokens.accessToken);
    expect(panelB.sync.activeRides).toEqual([]);
    const panelA = await s.openStand(a.tokens.accessToken);
    expect(panelA.sync.activeRides.map((r) => r.rideId)).toEqual([rideId]);
  }, 30_000);
});

describe('11. konum yayını yalnızca ride odasına', () => {
  it('eşleşmiş şoförün konumu ride odasındaki durağa gider; başka durağa ve eşleşmemiş şoföre gitmez', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const other = await s.stand(north(city, 40));
    const d = await s.driver(north(city, 200));
    const bystander = await s.driver(north(city, 260));
    const { rideId } = await matchRide(stand, d);

    const loc = north(city, 500);
    // Throttle 1/sn: iki güncelleme arasında bekle.
    d.socket.emit(DRIVER_EVENTS.locationUpdate, { location: loc, heading: 90, ts: Date.now() });
    const evs = await stand.rec.waitFor(RIDE_ROOM_EVENTS.driverLocation, forRide(rideId), { ms: 5000 });
    const ev = rideDriverLocationSchema.parse(evs[0]);
    expect(ev.location.lat).toBeCloseTo(loc.lat, 5);
    expect(ev.location.lng).toBeCloseTo(loc.lng, 5);
    expect(ev.heading).toBe(90);

    // Eşleşmemiş available şoförün konumu hiçbir odaya yayınlanmaz.
    await sleep(1100);
    bystander.socket.emit(DRIVER_EVENTS.locationUpdate, { location: north(city, 270), ts: Date.now() });
    await sleep(700);
    expect(stand.rec.count(RIDE_ROOM_EVENTS.driverLocation, (e) => e.location.lat !== undefined && Math.abs(e.location.lat - north(city, 270).lat) < 1e-6)).toBe(0);
    // Başka durak ve eşleşmemiş şoför ride odasında değildir.
    expect(other.rec.count(RIDE_ROOM_EVENTS.driverLocation)).toBe(0);
    expect(bystander.rec.count(RIDE_ROOM_EVENTS.driverLocation)).toBe(0);
    // Konum PG'ye yazılmaz (yalnızca Redis): rides satırında konum alanı yok; şoför hash'i güncel.
    expect(Number((await s.driverHash(d.id)).lat)).toBeCloseTo(loc.lat, 5);
  }, 40_000);

  it('eşleşme sonrası şoför busy: GEO\'da görünmez ama konumu hash\'te güncellenir', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    await matchRide(stand, d);
    const loc = north(city, 700);
    d.socket.emit(DRIVER_EVENTS.locationUpdate, { location: loc, ts: Date.now() });
    await waitFor(() => s.driverHash(d.id), (h) => Math.abs(Number(h.lat) - loc.lat) < 1e-6);
    expect(await s.inGeo(d.id)).toBe(false);
    expect((await s.driverHash(d.id)).status).toBe('busy');
  }, 30_000);
});
