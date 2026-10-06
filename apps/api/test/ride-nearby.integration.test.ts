// stand_nearby_drivers (worker `nearby` job'ı açık): max_radius_m içindeki `available` şoförler yalnızca ilgili
// durağın odasına gider; yarıçap dışındaki ve offline şoförler gitmez.
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { DRIVER_EVENTS, nearbyDriversSchema, QUEUES, STAND_EVENTS } from '@duraknet/shared';
import { startRideApp, type RideApp } from './helpers/ride-app';
import { distanceM } from './helpers/presence';
import { emitAck, north, Scope, sleep, uniqueCity, waitFor } from './helpers/rides';

let t: RideApp;
let s: Scope;
beforeAll(async () => {
  t = await startRideApp({ nearby: true, nearbyEveryMs: 400 });
});
afterEach(async () => {
  await s?.cleanup();
});
afterAll(async () => {
  await t?.close();
  // Paylaşılan Redis'te 400 ms'lik scheduler'ı bırakma (diğer dosyalar worker'sız bu kuyruğu beklemez).
  const conn = new Redis(inject('redisUrl'), { maxRetriesPerRequest: null });
  const q = new Queue(QUEUES.nearby, { connection: conn });
  await q.removeJobScheduler('stand-nearby').catch(() => undefined);
  await q.close();
  conn.disconnect();
});

type Ev = { drivers: { id: string; location: { lat: number; lng: number } }[] };
const ids = (e: Ev) => e.drivers.map((d) => d.id);

describe('stand_nearby_drivers', () => {
  it('yarıçap içi available şoförler duraktaki odaya gider; dışarıdaki, offline ve başka durağın şoförü gitmez', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 2000 });
    // Başka bir "şehir": ilk durağın olayları ona gitmemeli; kendi şoförü ilkine görünmemeli.
    const farCity = uniqueCity();
    const farStand = await s.stand(farCity, { initialRadiusM: 1000, maxRadiusM: 2000 });

    const inside = await s.driver(north(city, 500));
    const insideEdge = await s.driver(north(city, 1800));
    const outside = await s.driver(north(city, 5000));
    const offline = await s.driver(north(city, 600));
    const farDriver = await s.driver(north(farCity, 300));
    expect((await emitAck(offline.socket, DRIVER_EVENTS.goOffline, {})).ok).toBe(true);

    // go_offline'dan önce yayınlanmış olaylar offline şoförü içerebilir: yalnızca o şoför düştükten sonrakiler denetlenir.
    const withInside = (e: Ev) => ids(e).includes(inside.id) && ids(e).includes(insideEdge.id) && !ids(e).includes(offline.id);
    const evs = await stand.rec.waitFor(STAND_EVENTS.nearbyDrivers, withInside, { ms: 10_000 });
    const ev = evs[evs.length - 1] as Ev;
    nearbyDriversSchema.parse(ev);
    // Konumlar şoförün gönderdiği konumla uyumlu.
    const loc = ev.drivers.find((d) => d.id === inside.id)!.location;
    expect(distanceM(loc, north(city, 500))).toBeLessThan(5);

    // Birkaç tur daha. Paylaşılan kuyruğu birden fazla worker tüketebildiğinden bir job'ın olayı sonraki job'dan
    // geç ulaşabilir: offline şoför için "yerleşme" payı bırakılır, yalnızca ondan sonraki olaylar denetlenir.
    await sleep(1500);
    const settledAt = (stand.rec.all(STAND_EVENTS.nearbyDrivers) as Ev[]).length;
    await sleep(1500);
    const all = stand.rec.all(STAND_EVENTS.nearbyDrivers) as Ev[];
    expect(all.length - settledAt).toBeGreaterThanOrEqual(2);
    for (const e of all.slice(settledAt)) {
      expect(ids(e)).toContain(inside.id);
      expect(ids(e)).not.toContain(offline.id);
    }
    for (const e of all) {
      expect(ids(e)).not.toContain(outside.id);
      expect(ids(e)).not.toContain(farDriver.id);
    }

    // Diğer durağın odası kendi şoförünü görür, bizimkileri görmez.
    const farEvs = (await farStand.rec.waitFor(STAND_EVENTS.nearbyDrivers, (e: Ev) => ids(e).includes(farDriver.id), { ms: 10_000 })) as Ev[];
    for (const e of farStand.rec.all(STAND_EVENTS.nearbyDrivers) as Ev[]) {
      expect(ids(e)).not.toContain(inside.id);
      expect(ids(e)).not.toContain(insideEdge.id);
    }
    expect(farEvs.length).toBeGreaterThan(0);

    // Şoför offline olunca bir sonraki turlarda listeden düşer.
    expect((await emitAck(inside.socket, DRIVER_EVENTS.goOffline, {})).ok).toBe(true);
    await waitFor(
      async () => {
        const last = (stand.rec.all(STAND_EVENTS.nearbyDrivers) as Ev[]).at(-1);
        return last ? ids(last) : [];
      },
      (l) => !l.includes(inside.id) && l.includes(insideEdge.id),
      6000,
    );
  }, 60_000);

  it('busy (eşleşmiş) şoför listede görünmez', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 2000 });
    const a = await s.driver(north(city, 300));
    const b = await s.driver(north(city, 400));
    await stand.rec.waitFor(STAND_EVENTS.nearbyDrivers, (e: Ev) => ids(e).includes(a.id) && ids(e).includes(b.id), { ms: 10_000 });

    const { rideId } = await s.createRide(stand);
    await a.rec.waitFor(DRIVER_EVENTS.rideRequested, (r) => r.rideId === rideId, { ms: 10_000 });
    expect((await emitAck(a.socket, DRIVER_EVENTS.rideAccept, { rideId })).ok).toBe(true);
    await waitFor(
      async () => {
        const last = (stand.rec.all(STAND_EVENTS.nearbyDrivers) as Ev[]).at(-1);
        return last ? ids(last) : [];
      },
      (l) => !l.includes(a.id) && l.includes(b.id),
      6000,
    );
  }, 60_000);
});
