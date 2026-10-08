// Faz 3 ride yaşam döngüsü: durum geçişleri, VERSION_CONFLICT, şoför iptali, tamamlama (karar c),
// durak iptali. CLAUDE.md Bölüm 1 (state machine) ve "Mevcut durum" → Faz 3 kararı.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DRIVER_EVENTS, redisKeys, rideAcceptAckSchema, rideCompletedSchema, rideDriverCancelledSchema, rideSnapshotSchema,
  rideTakenSchema, STAND_EVENTS,
  type RideSnapshot,
} from '@duraknet/shared';
import { startRideApp, type RideApp } from './helpers/ride-app';
import {
  emitAck, errCode, north, Scope, sleep, uniqueCity, waitFor,
  type DriverActor, type StandActor,
} from './helpers/rides';

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

/** Çağrı açar, şoför kabul eder; matched snapshot'ı döner. */
async function matchRide(stand: StandActor, driver: DriverActor) {
  const { rideId } = await s.createRide(stand);
  await driver.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
  const ack = await emitAck<RideSnapshot>(driver.socket, DRIVER_EVENTS.rideAccept, { rideId });
  if (!ack.ok) throw new Error(`kabul başarısız: ${JSON.stringify(ack)}`);
  const snap = rideSnapshotSchema.parse(ack.data);
  await stand.rec.waitFor(STAND_EVENTS.rideMatched, forRide(rideId));
  return { rideId, version: snap.version, snap };
}

describe('3. geçersiz geçişler ve sürüm çakışması', () => {
  it('VERSION_CONFLICT: eski sürümle durak iptali reddedilir ve ride değişmez', async () => {
    s = new Scope(t);
    const stand = await s.stand(uniqueCity());
    const { rideId } = await s.createRide(stand);
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(rideId));
    const v = s.lastVersion(stand.rec, rideId);
    const stale = v > 0 ? v - 1 : v + 1;
    const ack = await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version: stale });
    expect(errCode(ack)).toBe('VERSION_CONFLICT');
    expect(await s.rideStatus(rideId)).toBe('searching');
    // Doğru sürümle iptal edilir; versiyon arttı.
    expect((await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version: v })).ok).toBe(true);
    const row = await s.ride(rideId);
    expect(row?.status).toBe('cancelled');
    expect(row?.version).toBeGreaterThan(v);
  }, 30_000);

  it('VERSION_CONFLICT: eski sürümle şoför iptali ve tamamlama reddedilir', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId, version } = await matchRide(stand, d);
    const stale = version > 0 ? version - 1 : version + 1;
    expect(errCode(await emitAck(d.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, version: stale }))).toBe('VERSION_CONFLICT');
    expect(errCode(await emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version: stale }))).toBe('VERSION_CONFLICT');
    expect(errCode(await emitAck(stand.socket, STAND_EVENTS.rideComplete, { rideId, version: stale }))).toBe('VERSION_CONFLICT');
    expect(await s.rideStatus(rideId)).toBe('matched');
  }, 30_000);

  it('INVALID_TRANSITION: searching ride tamamlanamaz; iptal edilmiş ride tekrar iptal/tamamlanamaz', async () => {
    s = new Scope(t);
    const stand = await s.stand(uniqueCity());
    const { rideId } = await s.createRide(stand);
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(rideId));
    const v = s.lastVersion(stand.rec, rideId);
    expect(errCode(await emitAck(stand.socket, STAND_EVENTS.rideComplete, { rideId, version: v }))).toBe('INVALID_TRANSITION');
    expect(await s.rideStatus(rideId)).toBe('searching');

    expect((await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version: v })).ok).toBe(true);
    const v2 = (await s.ride(rideId))!.version;
    expect(errCode(await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version: v2 }))).toBe('INVALID_TRANSITION');
    expect(errCode(await emitAck(stand.socket, STAND_EVENTS.rideComplete, { rideId, version: v2 }))).toBe('INVALID_TRANSITION');
    expect((await s.ride(rideId))?.status).toBe('cancelled');
  }, 30_000);

  it('INVALID_TRANSITION: tamamlanmış ride iptal edilemez; şoför kendi tamamladığı ride\'ı iptal edemez', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId, version } = await matchRide(stand, d);
    expect((await emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version })).ok).toBe(true);
    const v2 = (await s.ride(rideId))!.version;
    expect(errCode(await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version: v2 }))).toBe('INVALID_TRANSITION');
    expect(errCode(await emitAck(d.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, version: v2 }))).toBe('INVALID_TRANSITION');
    expect((await s.ride(rideId))?.status).toBe('completed');
  }, 30_000);

  it('başka durağın çağrısı iptal/tamamlanamaz; çağrıyı başkası tamamlayamaz', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const other = await s.stand(north(city, 50));
    const d = await s.driver(north(city, 200));
    const stranger = await s.driver(north(city, 210));
    const { rideId, version } = await matchRide(stand, d);

    const c = await emitAck(other.socket, STAND_EVENTS.rideCancel, { rideId, version });
    expect(c.ok).toBe(false);
    expect(['FORBIDDEN', 'NOT_FOUND']).toContain(errCode(c));
    const cc = await emitAck(other.socket, STAND_EVENTS.rideComplete, { rideId, version });
    expect(cc.ok).toBe(false);
    expect(['FORBIDDEN', 'NOT_FOUND']).toContain(errCode(cc));
    const sc = await emitAck(stranger.socket, DRIVER_EVENTS.rideComplete, { rideId, version });
    expect(sc.ok).toBe(false);
    expect(['FORBIDDEN', 'NOT_FOUND']).toContain(errCode(sc));
    const sx = await emitAck(stranger.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, version });
    expect(sx.ok).toBe(false);
    expect(['FORBIDDEN', 'NOT_FOUND']).toContain(errCode(sx));
    expect(await s.rideStatus(rideId)).toBe('matched');
  }, 30_000);

  it('VALIDATION_ERROR: geçersiz payload\'lar ack ile reddedilir', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    expect(errCode(await emitAck(stand.socket, STAND_EVENTS.rideCreate, { pickup: { lat: 999, lng: 0 }, pickupAddress: 'x' }))).toBe('VALIDATION_ERROR');
    expect(errCode(await emitAck(stand.socket, STAND_EVENTS.rideCreate, { pickup: city }))).toBe('VALIDATION_ERROR');
    expect(errCode(await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId: 'yok', version: 0 }))).toBe('VALIDATION_ERROR');
    const d = await s.driver(north(city, 100));
    expect(errCode(await emitAck(d.socket, DRIVER_EVENTS.rideAccept, { rideId: 'yok' }))).toBe('VALIDATION_ERROR');
  }, 30_000);

  it('olmayan ride için kabul/iptal NOT_FOUND ya da RIDE_NOT_AVAILABLE döner', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 100));
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect(['RIDE_NOT_AVAILABLE', 'NOT_FOUND']).toContain(errCode(await emitAck(d.socket, DRIVER_EVENTS.rideAccept, { rideId: ghost })));
    expect(['NOT_FOUND', 'FORBIDDEN']).toContain(errCode(await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId: ghost, version: 0 })));
  }, 30_000);
});

describe('4. şoför iptali: searching\'e dönüş', () => {
  it('ride searching\'e döner, driver_id boşalır, şoför excluded olur ve tekrar bildirilmez; durağa ride_driver_cancelled; aramayı başka şoför alır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 1000 });
    const a = await s.driver(north(city, 200));
    const b = await s.driver(north(city, 300));
    const { rideId, version } = await matchRide(stand, a);
    await b.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 }).catch(() => {});
    const beforeRow = await s.ride(rideId);
    const nA = a.rec.count(DRIVER_EVENTS.rideRequested, forRide(rideId));

    const ack = await emitAck(a.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, reason: 'lastik patladı', version });
    expect(ack.ok).toBe(true);

    // PG
    const row = await s.ride(rideId);
    expect(row?.status).toBe('searching');
    expect(row?.driver_id).toBeNull();
    expect(row?.version).toBeGreaterThan(version);
    expect(row?.searching_at?.getTime()).toBeGreaterThanOrEqual(beforeRow!.searching_at!.getTime());
    // Redis
    expect((await s.rideHash(rideId)).status).toBe('searching');
    expect((await s.rideHash(rideId)).driverId ?? '').toBe('');
    expect(await s.isExcluded(rideId, a.id)).toBe(true);
    const ah = await s.driverHash(a.id);
    expect(ah.status).toBe('available');
    expect(ah.rideId ?? '').toBe('');

    // Durak: ride_driver_cancelled + arama yeniden başlar (ride_searching).
    const ev = (await stand.rec.waitFor(STAND_EVENTS.rideDriverCancelled, forRide(rideId)))[0];
    rideDriverCancelledSchema.parse(ev);
    expect(ev.reason).toBe('lastik patladı');
    expect(ev.plate).toBe(a.plate);
    expect(ev.driverName).toBe('Test Şoför');
    expect(ev.version).toBeGreaterThan(version);
    const nSearch = stand.rec.count(STAND_EVENTS.rideSearching, forRide(rideId));
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(rideId), { n: nSearch + 2, ms: 10_000 });

    // İptal eden şoför tekrar bildirilmez ve kabul edemez; diğer şoför kabul eder.
    expect(a.rec.count(DRIVER_EVENTS.rideRequested, forRide(rideId))).toBe(nA);
    expect((await emitAck(a.socket, DRIVER_EVENTS.rideAccept, { rideId })).ok).toBe(false);
    await b.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    const ack2 = await emitAck<RideSnapshot>(b.socket, DRIVER_EVENTS.rideAccept, { rideId });
    expect(ack2.ok).toBe(true);
    const row2 = await s.ride(rideId);
    expect(row2?.status).toBe('matched');
    expect(row2?.driver_id).toBe(b.id);
    // Bir şoförün tek matched'ı: a serbest.
    expect(await t.db.selectFrom('rides').select('id').where('driver_id', '=', a.id).where('status', '=', 'matched').execute()).toHaveLength(0);
  }, 60_000);

  it('searching durumundaki ride\'ı şoför "iptal" edemez', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId } = await s.createRide(stand);
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId));
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(rideId));
    const ack = await emitAck(d.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, version: s.lastVersion(stand.rec, rideId) });
    expect(ack.ok).toBe(false);
    expect(['INVALID_TRANSITION', 'FORBIDDEN']).toContain(errCode(ack));
    expect(await s.rideStatus(rideId)).toBe('searching');
  }, 30_000);
});

describe('7. karar (c): tamamlama ve durak iptali', () => {
  it('şoför tamamlar: PG completed, durağa ride_completed, şoför busy\'den çıkar', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId, version } = await matchRide(stand, d);

    const ack = await emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version });
    expect(ack.ok).toBe(true);
    const row = await s.ride(rideId);
    expect(row?.status).toBe('completed');
    expect(row?.completed_at).toBeTruthy();
    expect(row?.version).toBeGreaterThan(version);
    const ev = (await stand.rec.waitFor(STAND_EVENTS.rideCompleted, forRide(rideId)))[0];
    rideCompletedSchema.parse(ev);
    // Şoför kendi tamamlamasında ack alır; ayrıca ride_completed gelmez.
    await sleep(300);
    expect(d.rec.count(DRIVER_EVENTS.rideCompleted)).toBe(0);
    // Şoför yeniden müsait (varsayım: tamamlama sonrası available + GEO'ya döner).
    const dh = await waitFor(() => s.driverHash(d.id), (h) => h.status !== 'busy');
    expect(dh.status).toBe('available');
    expect(dh.rideId ?? '').toBe('');
    expect(await s.inGeo(d.id)).toBe(true);
  }, 30_000);

  it('durak tamamlar: şoföre ride_completed gider, PG completed, şoför busy\'den çıkar', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId, version } = await matchRide(stand, d);

    const ack = await emitAck(stand.socket, STAND_EVENTS.rideComplete, { rideId, version });
    expect(ack.ok).toBe(true);
    const ev = (await d.rec.waitFor(DRIVER_EVENTS.rideCompleted, forRide(rideId)))[0];
    rideCompletedSchema.parse(ev);
    expect((await s.ride(rideId))?.status).toBe('completed');
    await stand.rec.waitFor(STAND_EVENTS.rideCompleted, forRide(rideId));
    const dh = await waitFor(() => s.driverHash(d.id), (h) => h.status !== 'busy');
    expect(dh.status).toBe('available');
    expect(await s.inGeo(d.id)).toBe(true);
  }, 30_000);

  it('iki kez tamamlama: ikincisi INVALID_TRANSITION (veya sürüm çakışması) döner; completed_at ve olay tekrarlanmaz', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId, version } = await matchRide(stand, d);

    expect((await emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version })).ok).toBe(true);
    const first = await s.ride(rideId);
    const second = await emitAck(stand.socket, STAND_EVENTS.rideComplete, { rideId, version });
    const third = await emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version: first!.version });
    expect(second.ok).toBe(false);
    expect(['INVALID_TRANSITION', 'VERSION_CONFLICT']).toContain(errCode(second));
    expect(third.ok).toBe(false);
    expect(errCode(third)).toBe('INVALID_TRANSITION');
    const row = await s.ride(rideId);
    expect(row?.completed_at?.getTime()).toBe(first?.completed_at?.getTime());
    expect(row?.version).toBe(first?.version);
    await sleep(300);
    expect(stand.rec.count(STAND_EVENTS.rideCompleted, forRide(rideId))).toBe(1);
    expect(d.rec.count(DRIVER_EVENTS.rideCompleted, forRide(rideId))).toBe(0);
  }, 30_000);

  it('şoför ve durak aynı anda tamamlar: tam biri kazanır; ride bir kez completed olur', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId, version } = await matchRide(stand, d);
    const [a, b] = await Promise.all([
      emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version }),
      emitAck(stand.socket, STAND_EVENTS.rideComplete, { rideId, version }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(['INVALID_TRANSITION', 'VERSION_CONFLICT']).toContain(errCode(loser));
    const row = await s.ride(rideId);
    expect(row?.status).toBe('completed');
    expect(row?.version).toBe(version + 1);
    await sleep(300);
    expect(stand.rec.count(STAND_EVENTS.rideCompleted, forRide(rideId))).toBe(1);
  }, 30_000);

  it('durak matched ride\'ı iptal eder: şoföre ride_cancelled, PG cancelled, şoför busy\'den çıkar', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const tablet = await s.openStand(stand.tokens.accessToken);
    const d = await s.driver(north(city, 200));
    const { rideId, version } = await matchRide(stand, d);

    const ack = await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, reason: 'müşteri gitti', version });
    expect(ack.ok).toBe(true);
    const ev = (await d.rec.waitFor(DRIVER_EVENTS.rideCancelled, forRide(rideId)))[0];
    expect(ev.reason).toBe('müşteri gitti');
    expect(ev.version).toBeGreaterThan(version);
    // Aynı durağın diğer tableti de iptal onayını alır.
    await tablet.rec.waitFor(STAND_EVENTS.rideCancelled, forRide(rideId));
    const row = await s.ride(rideId);
    expect(row?.status).toBe('cancelled');
    expect(row?.cancel_reason).toBe('müşteri gitti');
    const dh = await waitFor(() => s.driverHash(d.id), (h) => h.status !== 'busy');
    expect(dh.status).toBe('available');
    expect(dh.rideId ?? '').toBe('');
    expect(await s.inGeo(d.id)).toBe(true);
    // Eşleşme sonrası artık tamamlanamaz.
    expect(errCode(await emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version: row!.version }))).toBe('INVALID_TRANSITION');
    // Şoför yeni çağrı alabilir (serbest).
    const r2 = await s.createRide(stand);
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(r2.rideId), { ms: 10_000 });
  }, 40_000);

  it('eşleşme kapanınca (ride_taken) diğer adaylardan açık çağrı kalkar', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const a = await s.driver(north(city, 200));
    const b = await s.driver(north(city, 250));
    const { rideId } = await s.createRide(stand);
    await a.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId));
    await b.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId));
    expect(await t.redis.sismember(redisKeys.driverRequests(b.id), rideId)).toBe(1);
    expect((await emitAck(a.socket, DRIVER_EVENTS.rideAccept, { rideId })).ok).toBe(true);
    await b.rec.waitFor(DRIVER_EVENTS.rideTaken, forRide(rideId));
    expect(await t.redis.sismember(redisKeys.driverRequests(b.id), rideId)).toBe(0);
    expect(await t.redis.sismember(redisKeys.driverRequests(a.id), rideId)).toBe(0);
  }, 30_000);
});

describe('ride_taken.version ve ride_accept ack presenceVersion', () => {
  it('kabul ack presenceVersion taşır (busy geçişinin sürümü); ride_accepted düz snapshot kalır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId } = await s.createRide(stand);
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    const ack = await emitAck(d.socket, DRIVER_EVENTS.rideAccept, { rideId });
    expect(ack.ok).toBe(true);
    const data = rideAcceptAckSchema.parse((ack as { data: unknown }).data);
    expect(data.status).toBe('matched');
    expect(data.presenceVersion).toBeGreaterThan(d.goOnline!.presenceVersion);
    // Redis'teki güncel sürümle aynı; sonraki session_sync daha küçük sürüm taşımaz.
    expect(data.presenceVersion).toBe(Number(await t.redis.get(redisKeys.driverPresenceVersion(d.id))));
    const sync = await emitAck<{ presenceVersion: number; driverStatus: string }>(d.socket, DRIVER_EVENTS.sessionSyncRequest, {});
    expect(sync.ok && sync.data?.driverStatus).toBe('busy');
    expect(sync.ok && sync.data?.presenceVersion).toBe(data.presenceVersion);
    const [accepted] = await d.rec.waitFor(DRIVER_EVENTS.rideAccepted, forRide(rideId));
    expect('presenceVersion' in (accepted as object)).toBe(false);
    expect(rideSnapshotSchema.parse(accepted).version).toBe(data.version);
  }, 30_000);

  it('ride_taken: kabulde kaybeden adaya ve durak iptalinde adaylara kapanış sürümüyle gider', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const a = await s.driver(north(city, 200));
    const b = await s.driver(north(city, 300));
    const r1 = await s.createRide(stand);
    await a.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(r1.rideId), { ms: 10_000 });
    await b.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(r1.rideId), { ms: 10_000 });
    const ack = await emitAck<RideSnapshot>(a.socket, DRIVER_EVENTS.rideAccept, { rideId: r1.rideId });
    expect(ack.ok).toBe(true);
    const matchedVersion = (await s.ride(r1.rideId))!.version;
    const [taken] = await b.rec.waitFor(DRIVER_EVENTS.rideTaken, forRide(r1.rideId));
    expect(rideTakenSchema.parse(taken).version).toBe(matchedVersion);

    // Durak iptali (searching): adaylara iptal sürümüyle.
    const c = await s.driver(north(city, 250));
    const r2 = await s.createRide(stand);
    await c.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(r2.rideId), { ms: 10_000 });
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(r2.rideId));
    const v = s.lastVersion(stand.rec, r2.rideId);
    expect((await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId: r2.rideId, version: v })).ok).toBe(true);
    const [taken2] = await c.rec.waitFor(DRIVER_EVENTS.rideTaken, forRide(r2.rideId));
    expect(rideTakenSchema.parse(taken2).version).toBe((await s.ride(r2.rideId))!.version);
    expect(rideTakenSchema.parse(taken2).version).toBeGreaterThan(v);
  }, 60_000);

  it('kazananın diğer açık çağrıları ride_taken ile (güncel sürümle) kapanır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const r1 = await s.createRide(stand);
    const r2 = await s.createRide(stand);
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(r1.rideId), { ms: 10_000 });
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(r2.rideId), { ms: 10_000 });
    expect((await emitAck(d.socket, DRIVER_EVENTS.rideAccept, { rideId: r1.rideId })).ok).toBe(true);
    const [other] = await d.rec.waitFor(DRIVER_EVENTS.rideTaken, forRide(r2.rideId));
    expect(rideTakenSchema.parse(other).version).toBe((await s.ride(r2.rideId))!.version);
  }, 60_000);
});
