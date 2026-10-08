// Faz 4 kabul: uçtan uca yaşam döngüsü + eşleşen aracın canlı konumu (`ride_driver_location`).
// Gerçek PG + Redis + worker; her test kendi hesaplarını ve "şehrini" kurar.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DRIVER_EVENTS, PRESENCE, RIDE_ROOM_EVENTS, rideDriverLocationSchema, STAND_EVENTS,
  type LatLng, type RideSnapshot, type StandSessionSync,
} from '@duraknet/shared';
import { startRideApp, type RideApp } from './helpers/ride-app';
import {
  emitAck, errCode, north, Scope, sleep, uniqueCity, waitFor,
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
const LOC = DRIVER_EVENTS.locationUpdate;
const ROOM_LOC = RIDE_ROOM_EVENTS.driverLocation;
const THROTTLE_GAP = PRESENCE.LOCATION_THROTTLE_MS + 150;

async function matchRide(stand: StandActor, driver: DriverActor) {
  const { rideId } = await s.createRide(stand);
  await driver.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
  const ack = await emitAck<RideSnapshot>(driver.socket, DRIVER_EVENTS.rideAccept, { rideId });
  if (!ack.ok) throw new Error(`kabul başarısız: ${JSON.stringify(ack)}`);
  await stand.rec.waitFor(STAND_EVENTS.rideMatched, forRide(rideId));
  return { rideId, version: ack.data!.version };
}

/** Şoför konum yollar (throttle 1/sn, bu yüzden öncesinde bekler). Ayırt edilebilir bir konum döner. */
let seq = 0;
async function sendLoc(driver: DriverActor, base: LatLng): Promise<LatLng> {
  await sleep(THROTTLE_GAP);
  const location = { lat: base.lat + (++seq) * 0.00001, lng: base.lng };
  driver.socket.emit(LOC, { location, heading: 90, ts: Date.now() });
  return location;
}
const near = (a: LatLng, b: LatLng) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;
const locFor = (rideId: string, loc: LatLng) => (e: { rideId: string; location: LatLng }) => e.rideId === rideId && near(e.location, loc);

/**
 * Gözlemci: BAŞKA, askıya alınmayan bir durağın soketi; test onu `t.io` ile doğrudan ride odasına sokar.
 * Böylece durağın soketleri kesilse / odadan çıkarılsa bile "yayın gerçekten yapılmadı" kanıtlanabilir:
 * `pin` gözlemciyi odaya (yeniden) alır, `barrier` odaya sonradan bir sonda olayı yollayıp gözlemcinin
 * onu aldığını bekler (gözlemci canlı ve odada; öncesinde sızan konum olsaydı sondadan önce gelirdi).
 */
let probeSeq = 0;
async function makeSpy() {
  const standA = await s.stand(uniqueCity());
  const nsp = () => t.io.of('/stand');
  return {
    rec: standA.rec,
    async pin(rideId: string) {
      nsp().in(`stand:${standA.id}`).socketsJoin(`ride:${rideId}`);
      await sleep(250);
    },
    async barrier(rideId: string) {
      const name = `test_probe_${++probeSeq}`;
      nsp().to(`ride:${rideId}`).emit(name, { rideId });
      await standA.rec.waitFor(name, () => true, { ms: 5000 });
    },
  };
}

describe('(a) uçtan uca: çağrı → kabul → konum akışı → panel yenileme → tamamla', () => {
  it('konum durağa ride_driver_location olarak ulaşır; yenilenen panel session_sync ve session_sync_request ile şoför konumunu alır; tamamlanır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId } = await matchRide(stand, d);

    const p1 = await sendLoc(d, north(city, 400));
    const got = await stand.rec.waitFor(ROOM_LOC, locFor(rideId, p1));
    const ev = rideDriverLocationSchema.parse(got[0]);
    expect(ev.heading).toBe(90);
    expect(ev.ts).toBeGreaterThan(0);

    // Panel yenileme: eski soket kapanır, yeni /stand bağlantısı.
    const p2 = await sendLoc(d, north(city, 450));
    await stand.rec.waitFor(ROOM_LOC, locFor(rideId, p2));
    stand.socket.close();
    const fresh = await s.openStand(stand.tokens.accessToken);
    const fromConnect = fresh.sync.activeRides.find(forRide(rideId));
    expect(fromConnect?.status).toBe('matched');
    expect(fromConnect?.driver?.id).toBe(d.id);
    expect(fromConnect?.driver?.location).toBeDefined();
    expect(near(fromConnect!.driver!.location!, p2)).toBe(true);

    const p3 = await sendLoc(d, north(city, 500));
    // Yeni soket de canlı akışa katılmış olmalı (odaya session_sync'te alınır).
    await fresh.rec.waitFor(ROOM_LOC, locFor(rideId, p3));
    const req = await emitAck<StandSessionSync>(fresh.socket, STAND_EVENTS.sessionSyncRequest, {});
    if (!req.ok) throw new Error(`session_sync_request başarısız: ${JSON.stringify(req)}`);
    const viaReq = req.data!.activeRides.find(forRide(rideId));
    expect(viaReq?.driver?.location).toBeDefined();
    expect(near(viaReq!.driver!.location!, p3)).toBe(true);
    expect(typeof req.data!.serverTime).toBe('string');

    // Tamamla (şoför); durak completed alır, sonraki konum artık yayınlanmaz.
    const ack = await emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version: viaReq!.version });
    expect(ack.ok).toBe(true);
    expect((await s.ride(rideId))?.status).toBe('completed');
    await fresh.rec.waitFor(STAND_EVENTS.rideCompleted, forRide(rideId));
    const spy = await makeSpy();
    const p4 = await sendLoc(d, north(city, 550));
    // Gözlemci odaya zorla alınır: yayın yapılsaydı ulaşırdı; sonda olayı gözlemcinin canlı olduğunu kanıtlar.
    await spy.pin(rideId);
    await sleep(700);
    await spy.barrier(rideId);
    expect(spy.rec.count(ROOM_LOC, locFor(rideId, p4))).toBe(0);
    expect(fresh.rec.count(ROOM_LOC, locFor(rideId, p4))).toBe(0);
    const after = await emitAck<StandSessionSync>(fresh.socket, STAND_EVENTS.sessionSyncRequest, {});
    expect(after.ok).toBe(true);
    expect(after.ok ? after.data!.activeRides.find(forRide(rideId)) : null).toBeUndefined();
  }, 60_000);
});

describe('(b) şoför iptali: eski şoförün konumu yayınlanmaz, yeni şoförünki yayınlanır', () => {
  it('iptal → searching → eski şoför konumu düşer → yeni şoför kabul eder → yalnızca yeni şoförün konumu', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 1000 });
    const a = await s.driver(north(city, 200));
    const b = await s.driver(north(city, 300));
    // a'nın kabul etmesi için b'yi geçici olarak aday dışı bırakmaya gerek yok: ilk kabul eden kazanır.
    const { rideId, version } = await matchRide(stand, a);
    const matchedBy = (await s.ride(rideId))!.driver_id;
    expect(matchedBy).toBe(a.id);

    const a1 = await sendLoc(a, north(city, 420));
    await stand.rec.waitFor(ROOM_LOC, locFor(rideId, a1));

    const cancel = await emitAck(a.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, version });
    expect(cancel.ok).toBe(true);
    await s.waitRideStatus(rideId, 'searching');

    // a artık available; konumu ride odasına gitmemeli (gözlemci odaya zorla alınır, sonda ile canlılığı kanıtlanır).
    const spy = await makeSpy();
    await spy.pin(rideId);
    const a2 = await sendLoc(a, north(city, 430));
    await sleep(700);
    await spy.barrier(rideId);
    expect(spy.rec.count(ROOM_LOC, locFor(rideId, a2))).toBe(0);
    expect(stand.rec.count(ROOM_LOC, locFor(rideId, a2))).toBe(0);

    // b çağrıyı alır (a excluded) ve kabul eder.
    await b.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    expect(a.rec.count(DRIVER_EVENTS.rideRequested, forRide(rideId))).toBe(1); // yalnızca ilk bildirim
    const ack = await emitAck<RideSnapshot>(b.socket, DRIVER_EVENTS.rideAccept, { rideId });
    expect(ack.ok).toBe(true);
    await stand.rec.waitFor(STAND_EVENTS.rideMatched, (e) => e.rideId === rideId && e.driver.id === b.id);

    // Yeni şoförün konumu yayınlanır; a'nınki hâlâ yayınlanmaz.
    const b1 = await sendLoc(b, north(city, 600));
    await stand.rec.waitFor(ROOM_LOC, locFor(rideId, b1));
    const a3 = await sendLoc(a, north(city, 650));
    await sleep(700);
    await spy.pin(rideId); // gözlemci kesin odada
    await spy.barrier(rideId);
    expect(spy.rec.count(ROOM_LOC, locFor(rideId, a3))).toBe(0);
    expect(stand.rec.count(ROOM_LOC, locFor(rideId, a2))).toBe(0);
    expect(stand.rec.count(ROOM_LOC, locFor(rideId, a3))).toBe(0);

    // Panel yenilemesi yeni şoförü konumuyla gösterir.
    const fresh = await s.openStand(stand.tokens.accessToken);
    const snap = fresh.sync.activeRides.find(forRide(rideId));
    expect(snap?.driver?.id).toBe(b.id);
    expect(near(snap!.driver!.location!, b1)).toBe(true);
  }, 60_000);
});

describe('(c) durak iptali / askıya alma sonrası konum yayını durur', () => {
  it('durak iptali: şoför ride_cancelled alır, sonraki konum yayınlanmaz', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId, version } = await matchRide(stand, d);
    const p1 = await sendLoc(d, north(city, 400));
    await stand.rec.waitFor(ROOM_LOC, locFor(rideId, p1));

    const ack = await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version, reason: 'test' });
    expect(ack.ok).toBe(true);
    await d.rec.waitFor(DRIVER_EVENTS.rideCancelled, forRide(rideId));
    expect((await s.ride(rideId))?.status).toBe('cancelled');

    const spy = await makeSpy();
    await spy.pin(rideId);
    const p2 = await sendLoc(d, north(city, 450));
    await sleep(700);
    await spy.barrier(rideId);
    expect(spy.rec.count(ROOM_LOC, locFor(rideId, p2))).toBe(0);
    expect(stand.rec.count(ROOM_LOC, locFor(rideId, p2))).toBe(0);
  }, 40_000);

  it('durak askıya alma: ride stand_suspended ile iptal olur; şoförün sonraki konumu hiçbir yere yayınlanmaz', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const observer = await s.openStand(stand.tokens.accessToken); // askıya almadan önce açık ikinci tablet
    const spy = await makeSpy(); // askıya alınmayan başka durak; odaya zorla alınır
    const d = await s.driver(north(city, 200));
    const { rideId } = await matchRide(stand, d);
    const p1 = await sendLoc(d, north(city, 400));
    await observer.rec.waitFor(ROOM_LOC, locFor(rideId, p1));
    await spy.pin(rideId);
    const p1b = await sendLoc(d, north(city, 420));
    await spy.rec.waitFor(ROOM_LOC, locFor(rideId, p1b)); // gözlemci odada ve alıyor

    await t.adminAction('stands', stand.id, 'suspend');
    await waitFor(() => s.rideStatus(rideId), (st) => st === 'cancelled', 8000);
    const row = await s.ride(rideId);
    expect(row?.cancel_reason).toBe('stand_suspended');
    const cancelled = await d.rec.waitFor(DRIVER_EVENTS.rideCancelled, forRide(rideId));
    expect(cancelled[0].reason).toBe('stand_suspended');

    // Durak soketleri kesilmiş olabilir; asıl kanıt, odaya yeniden zorla alınan canlı gözlemcidir.
    await spy.pin(rideId);
    const p2 = await sendLoc(d, north(city, 450));
    await sleep(700);
    await spy.barrier(rideId);
    expect(spy.rec.count(ROOM_LOC, locFor(rideId, p2))).toBe(0);
    for (const rec of [stand.rec, observer.rec]) expect(rec.count(ROOM_LOC, locFor(rideId, p2))).toBe(0);
  }, 40_000);
});

describe('(d) üçüncü taraf odayı dinleyemez', () => {
  it('başka durağın soketi ve başka şoförün soketi ride_driver_location almaz; asıl durak alır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const otherCity = uniqueCity();
    const otherStand = await s.stand(otherCity);
    const d = await s.driver(north(city, 200));
    const bystander = await s.driver(north(city, 250)); // aynı bölgede, çağrıyı gören ama kabul etmeyen şoför
    const { rideId } = await matchRide(stand, d);

    const p1 = await sendLoc(d, north(city, 400));
    await stand.rec.waitFor(ROOM_LOC, locFor(rideId, p1));
    await sleep(500);
    expect(otherStand.rec.count(ROOM_LOC)).toBe(0);
    expect(bystander.rec.count(ROOM_LOC)).toBe(0);
    expect(d.rec.count(ROOM_LOC)).toBe(0); // yayın yalnızca /stand tarafına

    // Başka durağın panelini yeniler; matched ride'ı session_sync'te görmez ve odaya girmez.
    const otherFresh = await s.openStand(otherStand.tokens.accessToken);
    expect(otherFresh.sync.activeRides.find(forRide(rideId))).toBeUndefined();
    const p2 = await sendLoc(d, north(city, 450));
    await stand.rec.waitFor(ROOM_LOC, locFor(rideId, p2));
    await sleep(300);
    expect(otherFresh.rec.count(ROOM_LOC)).toBe(0);
    expect(otherStand.rec.count(ROOM_LOC)).toBe(0);

    // Başka durak bu ride'ı iptal/tamamlayamaz.
    const current = (await s.ride(rideId))!.version; // doğru sürüm: red VERSION_CONFLICT'ten değil sahiplikten gelmeli
    const bad = await emitAck(otherStand.socket, STAND_EVENTS.rideCancel, { rideId, version: current });
    expect(bad.ok).toBe(false);
    expect(['FORBIDDEN', 'NOT_FOUND']).toContain(errCode(bad));
    const badDone = await emitAck(otherStand.socket, STAND_EVENTS.rideComplete, { rideId, version: current });
    expect(badDone.ok).toBe(false);
    expect(['FORBIDDEN', 'NOT_FOUND']).toContain(errCode(badDone));
    expect((await s.ride(rideId))?.status).toBe('matched');
  }, 60_000);
});
