// Faz 3 dispatch (CLAUDE.md Bölüm 5, Senaryo 4): yarıçap dalgaları, sürekli tarama, aday filtreleri,
// çağrının kendiliğinden iptal edilmemesi, ride_still_open hatırlatması. Süreler FAST_TIMING ile kısaltılmıştır.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DRIVER_EVENTS, redisKeys, rideRequestSchema, rideSearchingSchema, rideStillOpenSchema, STAND_EVENTS,
} from '@duraknet/shared';
import { startRideApp, type RideApp } from './helpers/ride-app';
import { emitAck, north, Scope, sleep, uniqueCity } from './helpers/rides';

let t: RideApp;
let s: Scope;
beforeAll(async () => {
  t = await startRideApp();
});
afterEach(async () => {
  await s?.cleanup();
});
afterAll(async () => {
  await t?.close();
});

const requested = (rideId: string) => (e: { rideId: string }) => e.rideId === rideId;

describe('ride_create ve dalga araması', () => {
  it('ride searching olur; ride_searching payload\'ı şemaya uyar; yarıçap dalgaları initial → 2×initial → max', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 3000 });
    const { rideId, shortCode } = await s.createRide(stand);
    expect(shortCode).toMatch(/^[A-Z0-9]{4,8}$/i);

    const row = await s.waitRideStatus(rideId, 'searching');
    expect(row).toBe('searching');
    const ride = await s.ride(rideId);
    expect(ride?.searching_at).toBeTruthy();

    // En az 5 ride_searching: 1000, 2000, 3000, 3000 (sürekli tarama), 3000 ...
    const evs = await stand.rec.waitFor(STAND_EVENTS.rideSearching, requested(rideId), { n: 5, ms: 15_000 });
    for (const e of evs) rideSearchingSchema.parse(e);
    expect(evs.slice(0, 5).map((e) => e.radiusM)).toEqual([1000, 2000, 3000, 3000, 3000]);
    // Dalga numaraları artar; her dalga yalnızca bir kez bildirilir (job id idempotensi).
    const waves = evs.map((e) => e.wave as number);
    expect(new Set(waves).size).toBe(waves.length);
    expect([...waves].sort((a, b) => a - b)).toEqual(waves);
    // searchingSince sabittir (searching_at).
    expect(new Set(evs.map((e) => e.searchingSince)).size).toBe(1);
  }, 40_000);

  it('yalnızca yarıçaptaki, available, taze konumlu, hariç tutulmayan şoförlere ride_requested gider', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 3000 });
    const near = await s.driver(north(city, 400));
    const mid = await s.driver(north(city, 1500));
    const far = await s.driver(north(city, 2600));
    const outside = await s.driver(north(city, 6000));
    const offline = await s.driver(north(city, 300));
    await emitAck(offline.socket, DRIVER_EVENTS.goOffline, {});
    const stale = await s.driver(north(city, 350));
    // Konumu 40 sn önce güncellenmiş gibi (GEO'da kalır; LOCATION_FRESH_MS = 30 sn).
    await t.redis.hset(redisKeys.driver(stale.id), 'updatedAt', String(Date.now() - 40_000));

    const { rideId } = await s.createRide(stand);

    const [rNear] = await near.rec.waitFor(DRIVER_EVENTS.rideRequested, requested(rideId));
    const rMid = (await mid.rec.waitFor(DRIVER_EVENTS.rideRequested, requested(rideId), { ms: 10_000 }))[0];
    const rFar = (await far.rec.waitFor(DRIVER_EVENTS.rideRequested, requested(rideId), { ms: 10_000 }))[0];
    for (const r of [rNear, rMid, rFar]) rideRequestSchema.parse(r);
    expect(rNear.distanceM).toBeGreaterThan(300);
    expect(rNear.distanceM).toBeLessThan(500);
    expect(rNear.standName).toBeTruthy();
    expect(rNear.pickupAddress).toBe('Test Mah. Test Sk. No:1');

    // Birkaç tarama daha geçsin: dışarıdaki, offline ve bayat konumlu şoför hiç bildirilmez.
    await sleep(1500);
    expect(outside.rec.count(DRIVER_EVENTS.rideRequested)).toBe(0);
    expect(offline.rec.count(DRIVER_EVENTS.rideRequested)).toBe(0);
    expect(stale.rec.count(DRIVER_EVENTS.rideRequested)).toBe(0);
    // Tekrar tarama aynı adaya ikinci kez bildirmez.
    expect(near.rec.count(DRIVER_EVENTS.rideRequested, requested(rideId))).toBe(1);
    expect(mid.rec.count(DRIVER_EVENTS.rideRequested, requested(rideId))).toBe(1);
    expect(far.rec.count(DRIVER_EVENTS.rideRequested, requested(rideId))).toBe(1);

    // Adaylar Redis'te; bildirilmeyenler değil.
    expect(await s.isCandidate(rideId, near.id)).toBe(true);
    expect(await s.isCandidate(rideId, outside.id)).toBe(false);
    expect(await s.isCandidate(rideId, offline.id)).toBe(false);
    expect(await s.isCandidate(rideId, stale.id)).toBe(false);
    // Şoföre gösterilen açık çağrı kümesi.
    expect(await t.redis.sismember(redisKeys.driverRequests(near.id), rideId)).toBe(1);
    // Teklif alan şoför available kalır.
    expect((await s.driverHash(near.id)).status).toBe('available');
  }, 40_000);

  it('sonradan aktif olan şoföre (aramayı yakalayan) bildirim gider; hariç tutulan (reddeden) şoföre tekrar gitmez', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 2000 });
    const early = await s.driver(north(city, 300));
    const { rideId } = await s.createRide(stand);
    await early.rec.waitFor(DRIVER_EVENTS.rideRequested, requested(rideId));

    // Hiç aday olmayan biri sonradan aktif olur (ya da bölgeye girer).
    const late = await s.driver(north(city, 500), { online: false });
    expect(late.rec.count(DRIVER_EVENTS.rideRequested)).toBe(0);
    await emitAck(late.socket, DRIVER_EVENTS.goOnline, { location: north(city, 500) });
    await late.rec.waitFor(DRIVER_EVENTS.rideRequested, requested(rideId), { ms: 10_000 });

    // Reddeden: ack ok, ride açık kalır, sonraki taramalarda yeniden bildirilmez.
    const dec = await emitAck(early.socket, DRIVER_EVENTS.rideDecline, { rideId });
    expect(dec.ok).toBe(true);
    expect(await s.isExcluded(rideId, early.id)).toBe(true);
    const before = early.rec.count(DRIVER_EVENTS.rideRequested, requested(rideId));
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, requested(rideId), { n: 3 + stand.rec.count(STAND_EVENTS.rideSearching), ms: 10_000 });
    expect(early.rec.count(DRIVER_EVENTS.rideRequested, requested(rideId))).toBe(before);
    expect(await s.rideStatus(rideId)).toBe('searching');
    // Reddeden artık kabul edemez.
    expect((await emitAck(early.socket, DRIVER_EVENTS.rideAccept, { rideId })).ok).toBe(false);
    // Diğer aday kabul edebilir.
    expect((await emitAck(late.socket, DRIVER_EVENTS.rideAccept, { rideId })).ok).toBe(true);
  }, 40_000);

  it('bildirilen şoför sonraki taramalarda bir daha bildirilmez, yeni aday girince yalnızca o bildirilir', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 1000 });
    const a = await s.driver(north(city, 200));
    const { rideId } = await s.createRide(stand);
    await a.rec.waitFor(DRIVER_EVENTS.rideRequested, requested(rideId));
    const n0 = stand.rec.count(STAND_EVENTS.rideSearching);
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, requested(rideId), { n: n0 + 2, ms: 10_000 });
    expect(a.rec.count(DRIVER_EVENTS.rideRequested, requested(rideId))).toBe(1);
    const b = await s.driver(north(city, 250));
    await b.rec.waitFor(DRIVER_EVENTS.rideRequested, requested(rideId), { ms: 10_000 });
    expect(a.rec.count(DRIVER_EVENTS.rideRequested, requested(rideId))).toBe(1);
  }, 30_000);
});

describe('çağrı kendiliğinden iptal edilmez', () => {
  it('kimse yokken uzun süre searching kalır (max yarıçapta tarama sürer); yalnızca durak iptal eder ve açık çağrılar kapanır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 500, maxRadiusM: 1000 });
    const { rideId } = await s.createRide(stand);

    // 8 tarama (3 dalga + 5 sürekli) geçer; hâlâ searching.
    const evs = await stand.rec.waitFor(STAND_EVENTS.rideSearching, requested(rideId), { n: 8, ms: 20_000 });
    expect(evs.slice(3, 8).every((e) => e.radiusM === 1000)).toBe(true);
    expect(await s.rideStatus(rideId)).toBe('searching');
    expect((await s.rideHash(rideId)).status).toBe('searching');
    expect(stand.rec.count(STAND_EVENTS.rideCancelled)).toBe(0);

    // Bölgeye çok geç gelen şoför hâlâ çağrıyı alır.
    const late = await s.driver(north(city, 400));
    await late.rec.waitFor(DRIVER_EVENTS.rideRequested, requested(rideId), { ms: 10_000 });

    // Durak iptali: çağrı kapanır, açık çağrı şoförden kalkar, tarama durur.
    const version = s.lastVersion(stand.rec, rideId);
    const ack = await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, reason: 'müşteri vazgeçti', version });
    expect(ack.ok).toBe(true);
    await late.rec.waitFor(DRIVER_EVENTS.rideTaken, requested(rideId));
    await stand.rec.waitFor(STAND_EVENTS.rideCancelled, requested(rideId));
    const row = await s.ride(rideId);
    expect(row?.status).toBe('cancelled');
    expect(row?.cancel_reason).toBe('müşteri vazgeçti');
    expect(row?.cancelled_at).toBeTruthy();
    expect(await t.redis.sismember(redisKeys.driverRequests(late.id), rideId)).toBe(0);

    await sleep(800); // uçuştaki bir job olabilir
    const count = stand.rec.count(STAND_EVENTS.rideSearching, requested(rideId));
    await sleep(1200);
    expect(stand.rec.count(STAND_EVENTS.rideSearching, requested(rideId))).toBe(count);
    expect(late.rec.count(DRIVER_EVENTS.rideRequested, requested(rideId))).toBe(1);
  }, 60_000);
});

describe('10. ride_still_open hatırlatması', () => {
  it('searching sürdükçe durağa gelir, çağrıyı iptal etmez ve aramayı etkilemez; eşleşince durur', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 1000 });
    const { rideId } = await s.createRide(stand);

    const evs = await stand.rec.waitFor(STAND_EVENTS.rideStillOpen, requested(rideId), { n: 2, ms: 20_000 });
    for (const e of evs) rideStillOpenSchema.parse(e);
    expect(evs[1].minutesOpen).toBeGreaterThanOrEqual(evs[0].minutesOpen);
    expect(evs[0].searchingSince).toBeTruthy();
    // Hatırlatma iptal etmedi ve dispatch sürüyor.
    expect(await s.rideStatus(rideId)).toBe('searching');
    const before = stand.rec.count(STAND_EVENTS.rideSearching, requested(rideId));
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, requested(rideId), { n: before + 2, ms: 10_000 });
    expect(stand.rec.count(STAND_EVENTS.rideCancelled)).toBe(0);

    // Eşleşince hatırlatma durur.
    const d = await s.driver(north(city, 200));
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, requested(rideId), { ms: 10_000 });
    expect((await emitAck(d.socket, DRIVER_EVENTS.rideAccept, { rideId })).ok).toBe(true);
    await sleep(500); // uçuştaki job
    const n = stand.rec.count(STAND_EVENTS.rideStillOpen, requested(rideId));
    await sleep(2000);
    expect(stand.rec.count(STAND_EVENTS.rideStillOpen, requested(rideId))).toBe(n);
  }, 60_000);

  it('hatırlatma yalnızca searching iken gelir: iptal edilen çağrı için durur', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const { rideId } = await s.createRide(stand);
    await stand.rec.waitFor(STAND_EVENTS.rideStillOpen, requested(rideId), { ms: 15_000 });
    const version = s.lastVersion(stand.rec, rideId);
    expect((await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version })).ok).toBe(true);
    await sleep(500);
    const n = stand.rec.count(STAND_EVENTS.rideStillOpen, requested(rideId));
    await sleep(2000);
    expect(stand.rec.count(STAND_EVENTS.rideStillOpen, requested(rideId))).toBe(n);
  }, 40_000);
});
