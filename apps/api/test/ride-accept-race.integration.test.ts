// Faz 3 KABUL KRİTERİ: 50 şoför aynı anda ride_accept gönderir → tam 1 eşleşme (CLAUDE.md Bölüm 5, Senaryo 5).
// Ayrıca compensating action: Redis Lua başarılı ama PG koşullu UPDATE 0 satır dönerse Redis geri alınır.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DRIVER_EVENTS, redisKeys, STAND_EVENTS, rideSnapshotSchema, type RideSnapshot } from '@duraknet/shared';
import { startRideApp, type RideApp } from './helpers/ride-app';
import { emitAck, errCode, north, Scope, sleep, uniqueCity, waitFor, type DriverActor } from './helpers/rides';

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

describe('FCFS atomik kabul', () => {
  it('50 şoför aynı anda ride_accept → tam 1 başarı, 49 RIDE_NOT_AVAILABLE; PG\'de tek matched satır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 3000, maxRadiusM: 3000 });

    // 50 şoför, hepsi 3 km içinde.
    const N = 50;
    const drivers: DriverActor[] = [];
    for (let i = 0; i < N; i += 5) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(5, N - i) }, (_, j) => s.driver(north(city, 100 + (i + j) * 20))),
      );
      drivers.push(...batch);
    }
    expect(drivers).toHaveLength(N);

    const { rideId } = await s.createRide(stand);
    // GEOSEARCH COUNT 25: hepsi aday olana kadar (sonraki taramalarla) bekle. Yarış ancak herkes adayken anlamlıdır.
    await Promise.all(
      drivers.map((d) => d.rec.waitFor(DRIVER_EVENTS.rideRequested, (r) => r.rideId === rideId, { ms: 20_000 })),
    );

    // Hepsi aynı anda gönderir.
    const results = await Promise.all(
      drivers.map((d) => emitAck<RideSnapshot>(d.socket, DRIVER_EVENTS.rideAccept, { rideId })),
    );
    const winners = results.map((r, i) => ({ r, d: drivers[i]! })).filter((x) => x.r.ok);
    const losers = results.map((r, i) => ({ r, d: drivers[i]! })).filter((x) => !x.r.ok);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(N - 1);
    expect(losers.every((l) => errCode(l.r) === 'RIDE_NOT_AVAILABLE')).toBe(true);

    const winner = winners[0]!.d;
    const snap = rideSnapshotSchema.parse((winners[0]!.r as { data: unknown }).data);
    expect(snap.status).toBe('matched');
    expect(snap.rideId).toBe(rideId);
    expect(snap.driver?.id).toBe(winner.id);

    // PG: tek matched satır, kazanan şoförle.
    const row = await s.ride(rideId);
    expect(row?.status).toBe('matched');
    expect(row?.driver_id).toBe(winner.id);
    expect(row?.matched_at).toBeTruthy();
    const matchedRows = await t.db.selectFrom('rides').select('id').where('status', '=', 'matched').where('driver_id', 'in', drivers.map((d) => d.id)).execute();
    expect(matchedRows).toHaveLength(1);

    // Redis: ride matched, kazanan busy (+rideId) ve GEO'da değil; kaybedenler available ve GEO'da.
    expect((await s.rideHash(rideId)).status).toBe('matched');
    expect((await s.rideHash(rideId)).driverId).toBe(winner.id);
    const wh = await s.driverHash(winner.id);
    expect(wh.status).toBe('busy');
    expect(wh.rideId).toBe(rideId);
    expect(await s.inGeo(winner.id)).toBe(false);
    for (const l of losers.slice(0, 5)) {
      expect((await s.driverHash(l.d.id)).status).toBe('available');
      expect(await s.inGeo(l.d.id)).toBe(true);
    }

    // Olaylar: kazanana ride_accepted, kaybedenlere ride_taken (kazanana değil), durağa tam 1 ride_matched.
    await winner.rec.waitFor(DRIVER_EVENTS.rideAccepted, (e) => e.rideId === rideId);
    expect(winner.rec.count(DRIVER_EVENTS.rideTaken, (e) => e.rideId === rideId)).toBe(0);
    await Promise.all(losers.map((l) => l.d.rec.waitFor(DRIVER_EVENTS.rideTaken, (e) => e.rideId === rideId)));
    const matched = await stand.rec.waitFor(STAND_EVENTS.rideMatched, (e) => e.rideId === rideId);
    expect(matched).toHaveLength(1);
    expect(matched[0].driver.id).toBe(winner.id);
    await sleep(300);
    expect(stand.rec.count(STAND_EVENTS.rideMatched, (e) => e.rideId === rideId)).toBe(1);
    // Kazanan dışında kimse ride_accepted almaz.
    const accepted = drivers.filter((d) => d.rec.count(DRIVER_EVENTS.rideAccepted) > 0);
    expect(accepted.map((d) => d.id)).toEqual([winner.id]);
  }, 90_000);

  it('eşleşmeden sonra gelen geç kabul RIDE_NOT_AVAILABLE; aynı şoför ikinci ride\'ı kabul edemez', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const a = await s.driver(north(city, 200));
    const b = await s.driver(north(city, 300));
    const r1 = await s.createRide(stand);
    await a.rec.waitFor(DRIVER_EVENTS.rideRequested, (e) => e.rideId === r1.rideId);
    await b.rec.waitFor(DRIVER_EVENTS.rideRequested, (e) => e.rideId === r1.rideId);

    expect((await emitAck(a.socket, DRIVER_EVENTS.rideAccept, { rideId: r1.rideId })).ok).toBe(true);
    const late = await emitAck(b.socket, DRIVER_EVENTS.rideAccept, { rideId: r1.rideId });
    expect(errCode(late)).toBe('RIDE_NOT_AVAILABLE');

    // a busy: ikinci çağrı ona bildirilmez ve kabul edemez (uq_driver_one_active_ride'a hiç düşmez).
    const r2 = await s.createRide(stand);
    await b.rec.waitFor(DRIVER_EVENTS.rideRequested, (e) => e.rideId === r2.rideId);
    expect(a.rec.count(DRIVER_EVENTS.rideRequested, (e) => e.rideId === r2.rideId)).toBe(0);
    const again = await emitAck(a.socket, DRIVER_EVENTS.rideAccept, { rideId: r2.rideId });
    expect(again.ok).toBe(false);
    expect(['NOT_A_CANDIDATE', 'DRIVER_NOT_AVAILABLE']).toContain(errCode(again));
    expect(await s.rideStatus(r2.rideId)).toBe('searching');
  }, 40_000);

  it('8. compensating action: PG UPDATE 0 satır dönerse Redis geri alınır ve şoför RIDE_NOT_AVAILABLE alır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 150));
    const { rideId } = await s.createRide(stand);
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, (e) => e.rideId === rideId);

    // PG ile Redis'i ayrıştır: PG'de ride artık 'searching' değil (koşullu UPDATE 0 satır etkileyecek),
    // Redis hâlâ 'searching'. Sapma senaryosu: örn. başka bir yolla kapatılmış ride.
    await t.db.updateTable('rides').set({ status: 'cancelled', cancelled_at: new Date() }).where('id', '=', rideId).execute();
    expect((await s.rideHash(rideId)).status).toBe('searching');

    const ack = await emitAck(d.socket, DRIVER_EVENTS.rideAccept, { rideId });
    expect(ack.ok).toBe(false);
    expect(errCode(ack)).toBe('RIDE_NOT_AVAILABLE');

    // Redis geri alındı: ride matched değil, şoför yeniden available + GEO'da, rideId yok.
    await waitFor(() => s.rideHash(rideId), (h) => h.status !== 'matched');
    const rh = await s.rideHash(rideId);
    expect(rh.status).not.toBe('matched');
    expect(rh.driverId ?? '').toBe('');
    const dh = await s.driverHash(d.id);
    expect(dh.status).toBe('available');
    expect(dh.rideId ?? '').toBe('');
    expect(await s.inGeo(d.id)).toBe(true);
    // PG'de hiçbir yerde matched satırı oluşmadı.
    const matched = await t.db.selectFrom('rides').select('id').where('driver_id', '=', d.id).where('status', '=', 'matched').execute();
    expect(matched).toHaveLength(0);
    // Şoför busy'ye takılı kalmadı: rideId anahtarı yok.
    expect(await t.redis.hget(redisKeys.driver(d.id), 'rideId')).toBeNull();
  }, 30_000);
});
