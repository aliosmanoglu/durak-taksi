// O2: kabul (Redis Lua + PG) ile durak iptalinin eşzamanlı yarışı. Nihai durum her iki sıralamada da tutarlı olmalı:
// PG `cancelled`, Redis'te ride `searching`/`matched`'a geri dönmez, terminal TTL konur, şoför `busy`'de kalmaz.
import { randomInt } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DRIVER_EVENTS, redisKeys, STAND_EVENTS, type RideSnapshot } from '@duraknet/shared';
import { startRideApp, type RideApp } from './helpers/ride-app';
import { emitAck, errCode, north, Scope, sleep, uniqueCity, waitFor } from './helpers/rides';

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

/** Redis'teki durum PG'deki `cancelled` ile tutarlı mı? Sorunların listesi (boşsa tutarlı). */
async function cancelledProblems(rideId: string, driverId: string, standId: string): Promise<string[]> {
  const problems: string[] = [];
  const r = t.redis;
  const h = await r.hgetall(redisKeys.ride(rideId));
  if (h.status === 'searching' || h.status === 'matched') problems.push(`ride hash status=${h.status} (cancelled olmalıydı)`);
  // Ride'a ait HER anahtarın TTL'i olmalı (sızıntı: -1 = süresiz).
  for (const k of await r.keys(`dn:ride:${rideId}*`)) {
    const ttl = await r.ttl(k);
    if (ttl === -1) problems.push(`${k} TTL'siz (sızıntı)`);
    else if (ttl > 3600) problems.push(`${k} TTL=${ttl} > terminal TTL`);
  }
  if ((await r.sismember(redisKeys.standActiveRides(standId), rideId)) === 1) problems.push('stand active_rides içinde kaldı');
  if ((await r.sismember(redisKeys.driverRequests(driverId), rideId)) === 1) problems.push('şoförün requests kümesinde kaldı');
  const dh = await r.hgetall(redisKeys.driver(driverId));
  if (dh.status !== 'available') problems.push(`şoför status=${dh.status} (available olmalıydı)`);
  if (dh.rideId) problems.push(`şoför hash rideId=${dh.rideId} kaldı`);
  if ((await r.geopos(redisKeys.geoAvailable, driverId))[0] == null) problems.push('şoför GEO\'da değil');
  return problems;
}

describe('O2: kabul ile durak iptali yarışı', () => {
  it('çok tekrar: PG cancelled, Redis terminal TTL\'li ve geri dönmemiş, şoför busy\'de kalmaz, anahtar sızıntısı yok', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 2000, maxRadiusM: 2000 });
    const d = await s.driver(north(city, 200));
    const outcome = { cancelWon: 0, acceptWonThenCancelled: 0 };

    for (let i = 0; i < 25; i++) {
      const { rideId } = await s.createRide(stand);
      await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
      const v = (await s.ride(rideId))!.version;
      const jitter = randomInt(0, 12);
      const [acc, can] = await Promise.all([
        emitAck<RideSnapshot>(d.socket, DRIVER_EVENTS.rideAccept, { rideId }),
        (async () => {
          await sleep(jitter);
          return emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version: v });
        })(),
      ]);

      // İkisi birden başarılı olamaz (iptal eski sürümü bekliyordu).
      expect(acc.ok && can.ok, `#${i} kabul ve iptal birlikte başarılı`).toBe(false);
      if (can.ok) {
        outcome.cancelWon++;
        expect(errCode(acc), `#${i} kaybeden kabul`).toBe('RIDE_NOT_AVAILABLE');
      } else {
        // Kabul kazandı: durak güncel sürümle yeniden iptal eder (matched → cancelled).
        expect(acc.ok, `#${i} iptal reddedildi ama kabul de başarısız (${JSON.stringify(can)} / ${JSON.stringify(acc)})`).toBe(true);
        expect(['VERSION_CONFLICT', 'INVALID_TRANSITION']).toContain(errCode(can));
        outcome.acceptWonThenCancelled++;
        const cur = (await s.ride(rideId))!;
        expect(cur.status).toBe('matched');
        const again = await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version: cur.version });
        expect(again.ok, `#${i} ikinci iptal: ${JSON.stringify(again)}`).toBe(true);
      }

      expect(await s.rideStatus(rideId), `#${i} PG`).toBe('cancelled');
      // Geç gelen rollback/mirror'ın durumu bozmasına karşı: yakınsamayı bekle, sonra bir kez daha doğrula.
      let problems: string[] = [];
      try {
        await waitFor(async () => (problems = await cancelledProblems(rideId, d.id, stand.id)), (p) => p.length === 0, 4000);
      } catch {
        throw new Error(`#${i} Redis tutarsız: ${problems.join('; ')}`);
      }
      await sleep(120);
      problems = await cancelledProblems(rideId, d.id, stand.id);
      expect(problems, `#${i} geç yazma sonrası Redis`).toEqual([]);
      // PG: şoförün matched satırı kalmadı.
      const matched = await t.db.selectFrom('rides').select('id').where('driver_id', '=', d.id).where('status', '=', 'matched').execute();
      expect(matched, `#${i} matched satır`).toHaveLength(0);
    }
    console.info('[O2] sonuç dağılımı', outcome);
  }, 120_000);
});
