// Y1 / O1: hata enjeksiyonu ve worker uzlaştırıcısı.
//  - Y1: `searching` ama dispatch job'sız ride (startSearch hep patlıyor / job'lar silindi) → uzlaştırıcı yeniden kurar,
//        arama sürer (sonradan gelen şoför bildirim alır).
//  - O1: `busy` ama (PG'de) `matched` ride'ı olmayan şoför → uzlaştırıcı `available` yapar ve GEO'ya geri yazar;
//        gerçekten `matched` ride'ı olan busy şoföre dokunmaz.
// Uzlaştırıcı aralığı backend yapılandırmasına bağlıdır: beklemeler cömert tutulur (RECONCILE_WAIT_MS).
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  DRIVER_EVENTS, DRIVER_HASH, QUEUES, redisKeys, STAND_EVENTS, STAND_SUSPENDED_REASON, type DispatchJobData,
} from '@duraknet/shared';
import type { DispatchScheduler } from '../src/rides/scheduler';
import { startRideApp, type RideApp } from './helpers/ride-app';
import { emitAck, north, Scope, sleep, uniqueCity, uuid, waitFor } from './helpers/rides';

const RECONCILE_WAIT_MS = 25_000;
const broken = { on: false, calls: 0 };

let t: RideApp;
let s: Scope;
let bullRedis: Redis;
let dispatchQ: Queue<DispatchJobData>;
beforeAll(async () => {
  t = await startRideApp({
    // Uzlaştırıcı: 2,5 sn'de bir tarar (paylaşılan PG/Redis'te başka dosyaların kasıtlı bozuk state'ini hemen onarmasın); yaş eşiği 1 sn (üretimde 30 sn). Bozukluk "iki kez gör" kuralıyla onarılır.
    extraWorkerTiming: { reconcileEveryMs: 2500, reconcileMinAgeMs: 1000 },
    wrapScheduler: (inner): DispatchScheduler => ({
      async startSearch(rideId, v) {
        if (broken.on) {
          broken.calls++;
          throw new Error('enjekte edilen startSearch hatası');
        }
        return inner.startSearch(rideId, v);
      },
      close: () => inner.close(),
    }),
  });
  bullRedis = new Redis(inject('redisUrl'), { maxRetriesPerRequest: null });
  dispatchQ = new Queue<DispatchJobData>(QUEUES.dispatch, { connection: bullRedis });
});
afterEach(async () => {
  broken.on = false;
  broken.calls = 0;
  await s?.cleanup();
});
afterAll(async () => {
  await dispatchQ?.close();
  await t?.close();
  // Paylaşılan Redis'te 2,5 sn'lik uzlaştırıcı scheduler'ı bırakma.
  const q = new Queue(QUEUES.reconcile, { connection: bullRedis });
  await q.removeJobScheduler('ride-reconcile').catch(() => undefined);
  await q.close();
  bullRedis?.disconnect();
});

const forRide = (rideId: string) => (e: { rideId: string }) => e.rideId === rideId;

async function jobsOf(rideId: string) {
  const jobs = await dispatchQ.getJobs(['delayed', 'waiting', 'active', 'prioritized', 'waiting-children'], 0, -1);
  return jobs.filter((j) => j.data.rideId === rideId);
}

describe('Y1: job\'sız searching ride', () => {
  it('startSearch kalıcı olarak patlıyor: ride PG\'de searching kalır, uzlaştırıcı dispatch\'i kurar; sonradan gelen şoförler de bildirim alır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 2000, maxRadiusM: 2000 });
    broken.on = true;
    // ride_create ack'i hata da dönebilir (mevcut davranış) ya da ok (düzeltme); önemli olan kalıcı state.
    const ack = await emitAck<{ rideId: string }>(stand.socket, STAND_EVENTS.rideCreate, {
      pickup: stand.location, pickupAddress: 'Test Mah. Test Sk. No:1',
    });
    const row = await waitFor(
      () => t.db.selectFrom('rides').select(['id', 'status']).where('stand_id', '=', stand.id).executeTakeFirst(),
      (r) => !!r, 5000,
    );
    const rideId = row!.id;
    s.rideIds.add(rideId);
    expect(row!.status).toBe('searching');
    expect(broken.calls).toBeGreaterThan(0);
    console.info('[Y1] ride_create ack:', ack.ok ? 'ok' : (ack as { error: { code: string } }).error.code);
    expect(await jobsOf(rideId)).toHaveLength(0); // gerçekten job'sız

    // Şoför ride'dan SONRA aktif olur: bildirim ancak dispatch kurulduysa gelir.
    const d1 = await s.driver(north(city, 300));
    await d1.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: RECONCILE_WAIT_MS });
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(rideId), { ms: 10_000 });
    expect((await jobsOf(rideId)).length).toBeGreaterThan(0);

    // Arama sürüyor: ikinci (daha geç) şoför de bildirim alır, kabul edebilir.
    const d2 = await s.driver(north(city, 400));
    await d2.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 15_000 });
    expect((await emitAck(d2.socket, DRIVER_EVENTS.rideAccept, { rideId })).ok).toBe(true);
    expect(await s.rideStatus(rideId)).toBe('matched');
  }, 120_000);

  it('arama sırasında dispatch/hatırlatma job\'ları silinir: zincir kopsa da uzlaştırıcı yeniden kurar, arama sürer', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 2000, maxRadiusM: 2000 });
    const { rideId } = await s.createRide(stand);
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(rideId), { ms: 10_000 });

    // Zinciri kır: dalga süresi 300 ms olduğundan 2 sn boyunca sürekli sil (etkin job biterken eklediğini de yakala).
    const end = Date.now() + 2000;
    let removed = 0;
    while (Date.now() < end) {
      for (const j of await jobsOf(rideId)) removed += await j.remove().then(() => 1, () => 0);
      await sleep(15);
    }
    expect(removed).toBeGreaterThan(0);
    const before = stand.rec.count(STAND_EVENTS.rideSearching, forRide(rideId));

    const d = await s.driver(north(city, 300));
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: RECONCILE_WAIT_MS });
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(rideId), { n: before + 2, ms: 15_000 });
    expect(await s.rideStatus(rideId)).toBe('searching');
    expect((await s.ride(rideId))?.cancelled_at).toBeNull();
  }, 120_000);
});

describe('O1: ride önbelleği sapması', () => {
  it("Redis ride hash'i matched ama PG searching (kabul geri alımı kaçtı) → hash searching'e döner, arama sürer", async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 2000, maxRadiusM: 2000 });
    const { rideId } = await s.createRide(stand);
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(rideId), { ms: 10_000 });
    const ghost = uuid();
    await t.redis.hset(redisKeys.ride(rideId), { status: 'matched', driverId: ghost });

    await waitFor(() => s.rideHash(rideId), (h) => h.status === 'searching', RECONCILE_WAIT_MS, 250);
    expect((await s.rideHash(rideId)).driverId ?? '').toBe('');
    // Arama devam ediyor: şimdi gelen şoför çağrıyı alır.
    const d = await s.driver(north(city, 300));
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: RECONCILE_WAIT_MS });
    expect((await emitAck(d.socket, DRIVER_EVENTS.rideAccept, { rideId })).ok).toBe(true);
  }, 120_000);
});

describe('O1: busy ama matched ride\'ı olmayan şoför', () => {
  /** Mirror hatasını taklit eder: PG'de ride kapanmış, Redis'te şoför hâlâ busy ve GEO dışı. */
  async function corruptToBusy(driverId: string, rideId: string) {
    await t.redis
      .multi()
      .hset(redisKeys.driver(driverId), { [DRIVER_HASH.status]: 'busy', [DRIVER_HASH.rideId]: rideId })
      .zrem(redisKeys.geoAvailable, driverId)
      .exec();
  }

  it('mirror kaçırıldı (ride PG\'de completed, şoför Redis\'te busy) → uzlaştırıcı available yapar ve GEO\'ya yazar', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 2000, maxRadiusM: 2000 });
    const d = await s.driver(north(city, 200));
    const { rideId } = await s.createRide(stand);
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    const acc = await emitAck<{ version: number }>(d.socket, DRIVER_EVENTS.rideAccept, { rideId });
    expect(acc.ok).toBe(true);
    const done = await emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version: (acc as { data: { version: number } }).data.version });
    expect(done.ok).toBe(true);
    await waitFor(() => s.driverHash(d.id), (h) => h.status === 'available', 3000);

    await corruptToBusy(d.id, rideId);
    expect((await s.driverHash(d.id)).status).toBe('busy');

    const h = await waitFor(() => s.driverHash(d.id), (x) => x.status === 'available', RECONCILE_WAIT_MS, 250);
    expect(h.rideId ?? '').toBe('');
    await waitFor(() => s.inGeo(d.id), (g) => g, 5000);
    // Yeniden çağrı alabilir.
    const r2 = await s.createRide(stand);
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(r2.rideId), { ms: 15_000 });
  }, 120_000);

  it('hash\'teki rideId PG\'de hiç yok → şoför available + GEO\'da', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const d = await s.driver(north(city, 200));
    await corruptToBusy(d.id, uuid());
    await waitFor(() => s.driverHash(d.id), (x) => x.status === 'available', RECONCILE_WAIT_MS, 250);
    await waitFor(() => s.inGeo(d.id), (g) => g, 5000);
    expect((await s.driverHash(d.id)).rideId ?? '').toBe('');
  }, 120_000);

  it('kontrol: gerçekten matched ride\'ı olan busy şoföre uzlaştırıcı dokunmaz', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 2000, maxRadiusM: 2000 });
    const d = await s.driver(north(city, 200));
    const { rideId } = await s.createRide(stand);
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    expect((await emitAck(d.socket, DRIVER_EVENTS.rideAccept, { rideId })).ok).toBe(true);

    await sleep(8000); // birkaç uzlaştırıcı turu
    const h = await s.driverHash(d.id);
    expect(h.status).toBe('busy');
    expect(h.rideId).toBe(rideId);
    expect(await s.inGeo(d.id)).toBe(false);
    expect(await s.rideStatus(rideId)).toBe('matched');
  }, 60_000);
});

describe('O5: durağı askıda olan açık ride (D5 uzlaştırıcı kuralı)', () => {
  it('API iptal yolu atlanmış (durak doğrudan DB üzerinden askıda): matched ve searching ride cancelled olur, şoför serbest kalır, adaylar ride_taken alır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 2000, maxRadiusM: 2000 });
    const a = await s.driver(north(city, 200));
    const r1 = await s.createRide(stand);
    await a.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(r1.rideId), { ms: 10_000 });
    expect((await emitAck(a.socket, DRIVER_EVENTS.rideAccept, { rideId: r1.rideId })).ok).toBe(true);
    const b = await s.driver(north(city, 300));
    const r2 = await s.createRide(stand);
    await b.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(r2.rideId), { ms: 10_000 });

    // releaseStandForSuspension çalışmadan askıya alma: yalnızca PG durumu değişir.
    await t.db.updateTable('stands').set({ status: 'suspended' }).where('id', '=', stand.id).execute();

    await s.waitRideStatus(r1.rideId, 'cancelled', RECONCILE_WAIT_MS);
    await s.waitRideStatus(r2.rideId, 'cancelled', RECONCILE_WAIT_MS);
    for (const id of [r1.rideId, r2.rideId]) expect((await s.ride(id))?.cancel_reason).toBe(STAND_SUSPENDED_REASON);

    await a.rec.waitFor(DRIVER_EVENTS.rideCancelled, (e) => e.rideId === r1.rideId && e.reason === STAND_SUSPENDED_REASON);
    await waitFor(() => s.driverHash(a.id), (h) => h.status === 'available', 5000);
    await waitFor(() => s.inGeo(a.id), (g) => g, 5000);
    const [taken] = await b.rec.waitFor(DRIVER_EVENTS.rideTaken, forRide(r2.rideId));
    expect(taken.version).toBe((await s.ride(r2.rideId))!.version);
    expect(await t.redis.smembers(redisKeys.driverRequests(b.id))).not.toContain(r2.rideId);
    for (const id of [r1.rideId, r2.rideId]) expect((await s.rideHash(id)).status).toBe('cancelled');
    expect(await t.redis.scard(redisKeys.standActiveRides(stand.id))).toBe(0);
  }, 120_000);
});
