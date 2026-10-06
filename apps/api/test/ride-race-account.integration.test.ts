// O3/O4: kabul ile hesap işlemlerinin yarışı.
//  - kabul || askıya alma  → ride `searching`'e döner, şoför offline (forced); asla "matched ama şoför askıda" kalmaz
//  - kabul || logout       → ride `matched` kalırsa şoför busy; `searching` ise şoför busy değil (logout eşleşmeyi bozmaz)
//  - askıya almada ride serbest bırakma hatası → şoför yine de forceOffline (O4)
import { randomInt } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DRIVER_EVENTS, rideSnapshotSchema, STAND_EVENTS, type RideSnapshot } from '@duraknet/shared';
import { startRideApp, type RideApp } from './helpers/ride-app';
import { emitAck, north, Scope, sleep, uniqueCity, waitFor, type DriverActor, type StandActor } from './helpers/rides';

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
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
/** Soket kopabildiği için ack gelmeyebilir; bu da geçerli bir sonuçtur. */
const tryAck = <T>(d: DriverActor, event: string, payload: unknown) =>
  emitAck<T>(d.socket, event, payload, 2500).catch(() => undefined);

/** `fn`'yi `ms` geciktirip çalıştırır; yarışın iki yönünü de denemek için. */
const after = async <T>(ms: number, fn: () => Promise<T>) => {
  if (ms > 0) await sleep(ms);
  return fn();
};

async function adminPost(path: string) {
  return t.http().post(path).set(bearer(await t.adminToken()));
}

describe('O3: kabul || askıya alma', () => {
  it('çok tekrar: ride searching\'e döner (matched kalmaz), şoför offline/forced + GEO dışı, başka şoför yine alabilir', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 2000, maxRadiusM: 2000 });
    const b = await s.driver(north(city, 300));
    const outcome = { suspendedBeforeAccept: 0, matchedThenReleased: 0 };

    for (let i = 0; i < 10; i++) {
      const a = await s.driver(north(city, 200));
      const { rideId } = await s.createRide(stand);
      await a.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
      await b.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });

      const j = randomInt(-12, 13);
      const [acc] = await Promise.all([
        after(Math.max(0, -j), () => tryAck<RideSnapshot>(a, DRIVER_EVENTS.rideAccept, { rideId })),
        after(Math.max(0, j), () => adminPost(`/admin/drivers/${a.id}/suspend`)),
      ]);
      if (acc?.ok) outcome.matchedThenReleased++;
      else outcome.suspendedBeforeAccept++;

      // Yakınsama: ride PG'de matched KALMAMALI (şoför askıda).
      try {
        await waitFor(async () => (await s.ride(rideId))?.status, (v) => v === 'searching', 8000);
      } catch {
        const row = await s.ride(rideId);
        const acct = await t.db.selectFrom('drivers').select('status').where('id', '=', a.id).executeTakeFirst();
        throw new Error(
          `#${i} ride askıdaki şoförle ${row?.status} kaldı (driver_id=${row?.driver_id}, hesap=${acct?.status}); ` +
            `acc=${JSON.stringify(acc)}; şoför hash=${JSON.stringify(await s.driverHash(a.id))}; ride hash=${JSON.stringify(await s.rideHash(rideId))}`,
        );
      }
      const row = (await s.ride(rideId))!;
      expect(row.driver_id, `#${i}`).toBeNull();
      await waitFor(() => s.driverHash(a.id), (h) => h.status === 'offline', 5000).catch(async () => {
        throw new Error(`#${i} askıdaki şoför offline olmadı: ${JSON.stringify(await s.driverHash(a.id))}`);
      });
      await sleep(150);
      const ah = await s.driverHash(a.id);
      expect(ah.status, `#${i}`).toBe('offline');
      expect(ah.rideId ?? '', `#${i}`).toBe('');
      expect(await s.inGeo(a.id), `#${i} GEO`).toBe(false);
      const rh = await s.rideHash(rideId);
      expect(rh.status, `#${i} ride hash`).toBe('searching');
      expect(rh.driverId ?? '', `#${i} ride hash driverId`).toBe('');

      // Arama sürer: B kabul eder, sonra tamamlar (B tekrar boşta).
      const ack = await emitAck<RideSnapshot>(b.socket, DRIVER_EVENTS.rideAccept, { rideId }, 10_000);
      expect(ack.ok, `#${i} B kabul: ${JSON.stringify(ack)}`).toBe(true);
      const done = await emitAck(b.socket, DRIVER_EVENTS.rideComplete, { rideId, version: (ack as { data: RideSnapshot }).data.version });
      expect(done.ok, `#${i} B tamamla`).toBe(true);
      await waitFor(() => s.driverHash(b.id), (h) => h.status === 'available', 3000);
    }
    console.info('[O3 askıya alma] sonuç dağılımı', outcome);
  }, 180_000);
});

describe('O3: kabul || logout', () => {
  it('çok tekrar: ride matched kalırsa şoför busy + aktif ride; searching ise şoför busy değil. Eşleşme yalnızca logout yüzünden bozulmaz', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 2000, maxRadiusM: 2000 });
    const outcome = { matched: 0, notMatched: 0 };

    for (let i = 0; i < 10; i++) {
      const a = await s.driver(north(city, 200));
      const { rideId } = await s.createRide(stand);
      await a.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });

      const j = randomInt(-12, 13);
      const [acc] = await Promise.all([
        after(Math.max(0, -j), () => tryAck<RideSnapshot>(a, DRIVER_EVENTS.rideAccept, { rideId })),
        after(Math.max(0, j), () => t.http().post('/auth/logout').set(bearer(a.tokens.accessToken))),
      ]);

      // Yakınsamayı bekle: PG ve Redis aynı hikâyeyi anlatmalı.
      const problems = async (): Promise<string[]> => {
        const p: string[] = [];
        const row = (await s.ride(rideId))!;
        const dh = await s.driverHash(a.id);
        const rh = await s.rideHash(rideId);
        if (row.status === 'matched') {
          if (row.driver_id !== a.id) p.push(`matched ama driver_id=${row.driver_id}`);
          if (dh.status !== 'busy' || dh.rideId !== rideId) p.push(`matched ride ama şoför hash=${JSON.stringify(dh)}`);
          if (rh.status !== 'matched') p.push(`matched ride ama Redis ride status=${rh.status}`);
          if (await s.inGeo(a.id)) p.push("busy şoför GEO'da");
        } else if (row.status === 'searching') {
          if (dh.status === 'busy') p.push(`searching ride ama şoför busy (rideId=${dh.rideId})`);
          if (rh.status !== 'searching') p.push(`searching ride ama Redis ride status=${rh.status}`);
          if (rh.driverId) p.push(`searching ride ama Redis driverId=${rh.driverId}`);
          if (row.driver_id) p.push(`searching ride ama PG driver_id=${row.driver_id}`);
        } else p.push(`beklenmeyen PG durumu ${row.status}`);
        return p;
      };
      let last: string[] = [];
      try {
        await waitFor(async () => (last = await problems()), (p) => p.length === 0, 6000);
      } catch {
        throw new Error(`#${i} tutarsız (acc=${JSON.stringify(acc)}): ${last.join('; ')}`);
      }
      await sleep(150);
      expect(await problems(), `#${i} geç yazma sonrası`).toEqual([]);

      const row = (await s.ride(rideId))!;
      // Logout bir şoför iptali değildir: durağa ride_driver_cancelled gitmemeli.
      expect(stand.rec.count(STAND_EVENTS.rideDriverCancelled, forRide(rideId)), `#${i}`).toBe(0);
      if (row.status === 'matched') {
        outcome.matched++;
        // Yeniden girişte activeRide ile devam edilir.
        const login = await t.loginDriver(a.phone.e164);
        expect(login.status).toBe(200);
        const conn = await s.openDriver(login.body.data.accessToken);
        expect(conn.sync.driverStatus).toBe('busy');
        const active = rideSnapshotSchema.parse(conn.sync.activeRide);
        expect(active.rideId).toBe(rideId);
        expect((await emitAck(conn.socket, DRIVER_EVENTS.rideComplete, { rideId, version: active.version })).ok).toBe(true);
      } else {
        outcome.notMatched++; // logout kabulden önce işlendi; ride açık kalır → durak kapatır
        await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version: row.version });
      }
    }
    console.info('[O3 logout] sonuç dağılımı', outcome);
  }, 180_000);
});

describe('O4: askıya almada ride serbest bırakma hatası', () => {
  async function withReleaseFailure<T>(fn: () => Promise<T>): Promise<T> {
    const svc = t.rides!;
    const original = svc.releaseDriverForSuspension;
    svc.releaseDriverForSuspension = async () => {
      throw new Error('enjekte edilen release hatası');
    };
    try {
      return await fn();
    } finally {
      svc.releaseDriverForSuspension = original;
    }
  }

  it("available şoför: release patlasa da şoför forced offline + GEO dışı; hesap PG'de askıda; refresh geçersiz", async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const a = await s.driver(north(city, 200));
    expect(await s.inGeo(a.id)).toBe(true);

    const res = await withReleaseFailure(() => adminPost(`/admin/drivers/${a.id}/suspend`));
    // Yanıt kodu (200 ya da 500) sözleşme değil; kalıcı etki önemli.
    console.info('[O4] release hatalı suspend yanıtı:', res.status);

    const row = await t.db.selectFrom('drivers').select(['status', 'token_version']).where('id', '=', a.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('suspended');
    expect(row.token_version).toBeGreaterThan(0);
    const ah = await waitFor(() => s.driverHash(a.id), (h) => h.status === 'offline', 5000);
    expect(ah.offlineReason).toBe('forced');
    expect(await s.inGeo(a.id)).toBe(false);
    const rr = await t.http().post('/auth/refresh').send({ refreshToken: a.tokens.refreshToken });
    expect(rr.status).not.toBe(200);
  }, 30_000);

  it("matched şoför: release patlasa da şoför offline olur; aynı suspend tekrarlanınca ride searching'e döner (idempotent)", async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand: StandActor = await s.stand(city, { initialRadiusM: 2000, maxRadiusM: 2000 });
    const a = await s.driver(north(city, 200));
    const { rideId } = await s.createRide(stand);
    await a.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    expect((await emitAck(a.socket, DRIVER_EVENTS.rideAccept, { rideId })).ok).toBe(true);
    await stand.rec.waitFor(STAND_EVENTS.rideMatched, forRide(rideId));

    const res = await withReleaseFailure(() => adminPost(`/admin/drivers/${a.id}/suspend`));
    console.info('[O4] matched + release hatalı suspend yanıtı:', res.status);
    const ah = await waitFor(() => s.driverHash(a.id), (h) => h.status === 'offline', 5000);
    expect(ah.offlineReason).toBe('forced');
    expect(await s.inGeo(a.id)).toBe(false);

    // Tekrar (hata yok): ride serbest kalır.
    const again = await adminPost(`/admin/drivers/${a.id}/suspend`);
    expect(again.status).toBe(200);
    await s.waitRideStatus(rideId, 'searching', 8000);
    const row = (await s.ride(rideId))!;
    expect(row.driver_id).toBeNull();
    expect(await s.isExcluded(rideId, a.id)).toBe(true);
    expect((await s.driverHash(a.id)).status).toBe('offline');
  }, 40_000);
});
