// Faz 5 kabul kriteri (2): "bir API node'u öldürülünce istemciler diğer node'a bağlanıp session_sync ile devam eder".
// Aynı PG + Redis'e bağlı birden çok API örneği (redis-adapter) tek süreçte kurulur. "Graceful" kayıp io.close() ile
// (istemciler kapatılır), "sert" kayıp TCP bağlantılarını kesip adapter'ın Redis bağlantılarını düşürerek simüle edilir
// (süreç ölmüş gibi: hiçbir kapanış paketi yok). Worker bir kez, ayrı bir bileşen olarak çalışır (üretimde de ayrı süreç).
import { afterEach, describe, expect, it } from 'vitest';
import {
  DRIVER_EVENTS, redisKeys, RIDE_ROOM_EVENTS, rideDriverLocationSchema, rideSnapshotSchema, STAND_EVENTS,
  type DriverSessionSync, type RideSnapshot, type StandSessionSync,
} from '@duraknet/shared';
import { startRideApp, type RideApp } from './helpers/ride-app';
import { emitAck, north, Scope, sleep, uniqueCity, waitFor } from './helpers/rides';

const nodes: RideApp[] = [];
const scopes: Scope[] = [];
afterEach(async () => {
  for (const sc of scopes.splice(0)) await sc.cleanup().catch(() => undefined);
  for (const n of nodes.splice(0)) await n.close().catch(() => undefined);
});

async function node(opts: { workers?: boolean } = {}) {
  const n = await startRideApp(opts);
  nodes.push(n);
  return n;
}
function scopeOf(n: RideApp) {
  const sc = new Scope(n);
  scopes.push(sc);
  return sc;
}
const forRide = (rideId: string) => (e: { rideId: string }) => e.rideId === rideId;

/** A düğümünde durak + şoför kurar, çağrıyı eşleştirir. */
async function matchedOnA(a: RideApp) {
  const sa = scopeOf(a);
  const city = uniqueCity();
  const stand = await sa.stand(city);
  const driver = await sa.driver(north(city, 200));
  const { rideId } = await sa.createRide(stand);
  await driver.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
  const ack = await emitAck<RideSnapshot>(driver.socket, DRIVER_EVENTS.rideAccept, { rideId });
  if (!ack.ok) throw new Error(`kabul başarısız: ${JSON.stringify(ack)}`);
  const snap = rideSnapshotSchema.parse(ack.data);
  await stand.rec.waitFor(STAND_EVENTS.rideMatched, forRide(rideId));
  return { sa, city, stand, driver, rideId, snap };
}

for (const mode of ['graceful', 'sert'] as const) {
  describe(`node kaybı (${mode})`, () => {
    async function loseA(a: RideApp, ...clients: { socket: { once(e: string, cb: () => void): unknown; connected: boolean } }[]) {
      const dropped = clients.map((c) => new Promise<void>((r) => (c.socket.connected ? c.socket.once('disconnect', () => r()) : r())));
      if (mode === 'sert') a.kill();
      else await new Promise<void>((r) => a.io.close(() => r()));
      await Promise.race([Promise.all(dropped), sleep(5000)]);
    }

    it('eşleşmiş ride varken A kaybolur; şoför ve durak B\'ye bağlanınca session_sync doğru state\'i verir', async () => {
      const a = await node();
      const b = await node({ workers: false });
      const { stand, driver, rideId, snap } = await matchedOnA(a);

      await loseA(a, stand, driver);
      expect(driver.socket.connected).toBe(false);
      expect(stand.socket.connected).toBe(false);

      // Presence: sokete bağlı olmayan busy şoför düşürülmez; ride Redis/PG'de matched.
      expect((await t_hash(b, driver.id)).status).toBe('busy');
      expect((await b.db.selectFrom('rides').select('status').where('id', '=', rideId).executeTakeFirstOrThrow()).status).toBe('matched');

      const sb = scopeOf(b);
      const d2 = await sb.openDriver(driver.tokens.accessToken);
      const dsync: DriverSessionSync = d2.sync;
      expect(dsync.driverStatus).toBe('busy');
      expect(dsync.activeRide).toBeDefined();
      const active = rideSnapshotSchema.parse(dsync.activeRide);
      expect(active.rideId).toBe(rideId);
      expect(active.status).toBe('matched');
      expect(active.version).toBe(snap.version);
      expect(active.driver?.id).toBe(driver.id);
      expect(active.pickup).toEqual(snap.pickup);
      expect(dsync.openRequests).toEqual([]);
      expect(typeof dsync.presenceVersion).toBe('number');

      const s2 = await sb.openStand(stand.tokens.accessToken);
      const ssync: StandSessionSync = s2.sync;
      const ride = ssync.activeRides.find((r) => r.rideId === rideId);
      expect(ride?.status).toBe('matched');
      expect(ride?.driver?.id).toBe(driver.id);
      expect(ride?.driver?.plate).toBe(driver.plate);

      // Süreç B'de devam eder: şoför konum yayar → durak (ride odası) görür; şoför tamamlar → durak ride_completed alır.
      const pos = north(stand.location, 250);
      await sleep(1100); // konum throttle'ı
      d2.socket.emit(DRIVER_EVENTS.locationUpdate, { location: pos, ts: Date.now() });
      const [loc] = await s2.rec.waitFor(RIDE_ROOM_EVENTS.driverLocation, forRide(rideId), { ms: 8000 });
      rideDriverLocationSchema.parse(loc);

      const done = await emitAck(d2.socket, DRIVER_EVENTS.rideComplete, { rideId, version: active.version });
      expect(done.ok, JSON.stringify(done)).toBe(true);
      await s2.rec.waitFor(STAND_EVENTS.rideCompleted, forRide(rideId), { ms: 8000 });
      expect((await t_hash(b, driver.id)).status).toBe('available');
    }, 60_000);

    it('boştaki (available) şoför node kaybında GEO\'dan düşmez; B\'de session_sync available döner ve çağrı alabilir', async () => {
      const a = await node();
      const b = await node({ workers: false });
      const sa = scopeOf(a);
      const city = uniqueCity();
      const driver = await sa.driver(north(city, 100));
      await loseA(a, driver);
      await sleep(500);
      expect(await sa.inGeo(driver.id)).toBe(true);

      const sb = scopeOf(b);
      const d2 = await sb.openDriver(driver.tokens.accessToken);
      expect(d2.sync.driverStatus).toBe('available');

      // Yeni çağrı (B'deki durak) → B'deki şoföre ulaşır.
      const stand = await sb.stand(city);
      const { rideId } = await sb.createRide(stand);
      await d2.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
      expect((await emitAck(d2.socket, DRIVER_EVENTS.rideAccept, { rideId })).ok).toBe(true);
    }, 60_000);

    it('A kapalıyken açık çağrı listesi (openRequests) B\'de session_sync ile yeniden gelir', async () => {
      const a = await node();
      const b = await node({ workers: false });
      const sa = scopeOf(a);
      const city = uniqueCity();
      const stand = await sa.stand(city);
      const driver = await sa.driver(north(city, 150));
      const { rideId } = await sa.createRide(stand);
      await driver.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
      await loseA(a, driver, stand);

      const d2 = await scopeOf(b).openDriver(driver.tokens.accessToken);
      expect(d2.sync.openRequests.map((r) => r.rideId)).toContain(rideId);
      expect(d2.sync.activeRide).toBeUndefined();
      // B'den kabul edilebilir.
      const ack = await emitAck(d2.socket, DRIVER_EVENTS.rideAccept, { rideId });
      expect(ack.ok, JSON.stringify(ack)).toBe(true);
      expect(await sa.waitRideStatus(rideId, 'matched')).toBe('matched');
    }, 60_000);
  });
}

const t_hash = (n: RideApp, id: string) => n.redis.hgetall(redisKeys.driver(id));

describe('adapter ile node\'lar arası yayın', () => {
  it('iki canlı node: durak A\'da, şoför B\'de; olaylar her iki yönde ulaşır (kabul, eşleşme, tamamlama)', async () => {
    const a = await node();
    const b = await node({ workers: false });
    const sa = scopeOf(a);
    const sb = scopeOf(b);
    const city = uniqueCity();
    const stand = await sa.stand(city);
    const driver = await sb.driver(north(city, 200));

    const { rideId } = await sa.createRide(stand);
    await driver.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    const acc = await emitAck<RideSnapshot>(driver.socket, DRIVER_EVENTS.rideAccept, { rideId });
    expect(acc.ok).toBe(true);
    const matched = await stand.rec.waitFor(STAND_EVENTS.rideMatched, forRide(rideId), { ms: 8000 });
    expect(matched[0].driver.id).toBe(driver.id);

    const version = (await sa.ride(rideId))!.version;
    expect((await emitAck(stand.socket, STAND_EVENTS.rideComplete, { rideId, version })).ok).toBe(true);
    await driver.rec.waitFor(DRIVER_EVENTS.rideCompleted, forRide(rideId), { ms: 8000 });
  }, 60_000);

  it('A sert ölürken B\'deki durak ile C\'deki şoför arasında kabul/tamamla olayları akmaya devam eder', async () => {
    const a = await node();
    const b = await node({ workers: false });
    const c = await node({ workers: false });
    const sb = scopeOf(b);
    const sc = scopeOf(c);
    const city = uniqueCity();
    const stand = await sb.stand(city);
    const driver = await sc.driver(north(city, 200));
    // A'da yalnızca bir istemci vardı; node kaybolur.
    const sa = scopeOf(a);
    const bystander = await sa.driver(north(city, 5000), { online: false });
    a.kill();
    await sleep(300);
    expect(bystander.socket.connected).toBe(false);

    const { rideId } = await sb.createRide(stand);
    await driver.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    const acc = await emitAck<RideSnapshot>(driver.socket, DRIVER_EVENTS.rideAccept, { rideId });
    expect(acc.ok).toBe(true);
    await stand.rec.waitFor(STAND_EVENTS.rideMatched, forRide(rideId), { ms: 8000 });

    const v = (await sb.ride(rideId))!.version;
    expect((await emitAck(driver.socket, DRIVER_EVENTS.rideComplete, { rideId, version: v })).ok).toBe(true);
    await stand.rec.waitFor(STAND_EVENTS.rideCompleted, forRide(rideId), { ms: 8000 });
    await waitFor(() => sb.rideStatus(rideId), (st) => st === 'completed', 3000);
  }, 60_000);

  it('askıya alma, hayatta kalan node üzerinden yine de her node\'daki soketi keser (A canlı iken)', async () => {
    const a = await node();
    const b = await node({ workers: false });
    const sa = scopeOf(a);
    const driver = await sa.driver();
    const dropped = new Promise<string>((r) => driver.socket.once('disconnect', (reason) => r(reason)));
    // Yönetici işlemi B'den değil A'nın HTTP'sinden gelir, kapatma B'deki soketi de kapsamalı: şoförü B'ye bağla.
    const sb = scopeOf(b);
    const onB = await sb.openDriver(driver.tokens.accessToken);
    const droppedB = new Promise<string>((r) => onB.socket.once('disconnect', (reason) => r(reason)));
    await b.adminAction('drivers', driver.id, 'suspend');
    expect(await dropped).toBe('io server disconnect');
    expect(await droppedB).toBe('io server disconnect');
  }, 40_000);
});
