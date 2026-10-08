// D5: durak askıya alınınca açık (searching / matched) çağrıları sistem iptal eder (tek istisna: `stand_suspended`).
//  - matched ride: PG cancelled (cancel_reason 'stand_suspended'), eşleşmiş şoföre ride_cancelled, şoför busy → available
//  - searching ride: PG cancelled, adaylara ride_taken (kapanış sürümüyle), requests kümesi temizlenir
//  - durağın tüm soketleri düşer; dispatch ride'ı yeniden açmaz
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DRIVER_EVENTS, redisKeys, rideCancelledSchema, rideTakenSchema, STAND_EVENTS, STAND_SUSPENDED_REASON,
} from '@duraknet/shared';
import { startRideApp, type RideApp } from './helpers/ride-app';
import { emitAck, north, Scope, sleep, uniqueCity, waitFor } from './helpers/rides';

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

const forRide = (rideId: string) => (e: { rideId: string }) => e.rideId === rideId;

describe('D5: durak askıya alma', () => {
  it('matched + searching ride iptal edilir; şoför serbest kalır, adaylar ride_taken alır, durağın iki soketi düşer', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 2000, maxRadiusM: 2000 });
    const second = await s.openStand(stand.tokens.accessToken); // ikinci tablet
    const a = await s.driver(north(city, 200));

    // ride1: yalnızca A çevrimiçi iken açılır ve A kabul eder → matched.
    const r1 = await s.createRide(stand);
    await a.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(r1.rideId), { ms: 10_000 });
    expect((await emitAck(a.socket, DRIVER_EVENTS.rideAccept, { rideId: r1.rideId })).ok).toBe(true);
    expect(await s.rideStatus(r1.rideId)).toBe('matched');

    // ride2: B ve C aday; kimse kabul etmez → searching.
    const b = await s.driver(north(city, 300));
    const c = await s.driver(north(city, 400));
    const r2 = await s.createRide(stand);
    await b.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(r2.rideId), { ms: 10_000 });
    await c.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(r2.rideId), { ms: 10_000 });
    expect(await s.rideStatus(r2.rideId)).toBe('searching');
    expect(await t.redis.smembers(redisKeys.driverRequests(b.id))).toContain(r2.rideId);
    const v1 = (await s.ride(r1.rideId))!.version;
    const v2Before = (await s.ride(r2.rideId))!.version;

    await t.adminAction('stands', stand.id, 'suspend');

    // PG: ikisi de cancelled + sebep.
    for (const id of [r1.rideId, r2.rideId]) {
      const row = await s.ride(id);
      expect(row?.status).toBe('cancelled');
      expect(row?.cancel_reason).toBe(STAND_SUSPENDED_REASON);
      expect(row?.cancelled_at).not.toBeNull();
    }
    expect((await s.ride(r1.rideId))!.version).toBe(v1 + 1);
    expect((await s.ride(r2.rideId))!.version).toBeGreaterThan(v2Before);

    // Eşleşmiş şoför: ride_cancelled (sebep + kapanış sürümü); busy → available, GEO'ya döner.
    const [cancelled] = await a.rec.waitFor(DRIVER_EVENTS.rideCancelled, forRide(r1.rideId));
    const ev = rideCancelledSchema.parse(cancelled);
    expect(ev.reason).toBe(STAND_SUSPENDED_REASON);
    expect(ev.version).toBe(v1 + 1);
    await waitFor(() => s.driverHash(a.id), (h) => h.status === 'available', 5000);
    expect((await s.driverHash(a.id)).rideId ?? '').toBe('');
    await waitFor(() => s.inGeo(a.id), (g) => g, 5000);
    // Yeni "busy → available" geçişi presenceVersion'ı artırmıştır.
    expect(Number(await t.redis.get(redisKeys.driverPresenceVersion(a.id)))).toBeGreaterThan(a.goOnline!.presenceVersion);

    // Adaylar: ride_taken (şemaya uygun, kapanış sürümü) ve açık çağrı kümesi temiz.
    const v2 = (await s.ride(r2.rideId))!.version;
    for (const d of [b, c]) {
      const [taken] = await d.rec.waitFor(DRIVER_EVENTS.rideTaken, forRide(r2.rideId));
      expect(rideTakenSchema.parse(taken).version).toBe(v2);
      expect(await t.redis.smembers(redisKeys.driverRequests(d.id))).not.toContain(r2.rideId);
    }
    // Eşleşmemiş ride için şoföre ride_cancelled gitmez; eşleşme olmadığı için ride_driver_cancelled da yok.
    expect(b.rec.count(DRIVER_EVENTS.rideCancelled)).toBe(0);
    expect(stand.rec.count(STAND_EVENTS.rideDriverCancelled)).toBe(0);

    // Redis ride hash'leri terminal; durağın açık kümesi boş.
    for (const id of [r1.rideId, r2.rideId]) expect((await s.rideHash(id)).status).toBe('cancelled');
    expect(await t.redis.scard(redisKeys.standActiveRides(stand.id))).toBe(0);

    // Durağın iki soketi de düşer; hesap yeniden bağlanamaz.
    await waitFor(async () => stand.socket.connected, (x) => !x, 5000);
    await waitFor(async () => second.socket.connected, (x) => !x, 5000);
    const err = await t.connectError('/stand', stand.tokens.accessToken);
    expect(['UNAUTHORIZED', 'ACCOUNT_SUSPENDED']).toContain(err.message);

    // Dispatch ride'ı yeniden açmaz: yeni bir şoför çağrı almaz, durum cancelled kalır.
    const late = await s.driver(north(city, 250));
    await late.rec.expectNone(DRIVER_EVENTS.rideRequested, 1200, forRide(r2.rideId));
    expect(await s.rideStatus(r2.rideId)).toBe('cancelled');
  }, 90_000);

  it('açık çağrısı olmayan durağı askıya almak sorunsuzdur; başka durağın çağrısına dokunulmaz', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const quiet = await s.stand(north(city, 10));
    const busyStand = await s.stand(city, { initialRadiusM: 2000, maxRadiusM: 2000 });
    const d = await s.driver(north(city, 200));
    const { rideId } = await s.createRide(busyStand);
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });

    await t.adminAction('stands', quiet.id, 'suspend');
    await sleep(500);
    expect(await s.rideStatus(rideId)).toBe('searching');
    expect(busyStand.socket.connected).toBe(true);
    expect(d.rec.count(DRIVER_EVENTS.rideTaken, forRide(rideId))).toBe(0);
  }, 60_000);
});
