// Faz 5 idempotency (docs/design/faz5-resilience.md Bölüm 3): ack kaybı sonrası istemci yeniden denemesi.
// ride_create clientRequestId ile tek ride üretir; terminal geçiş tekrarları aynı sonucu döner;
// sürüm uyuşmazlığı yalnızca durum hedefte değilse VERSION_CONFLICT'tir; yetki kontrolü sonuç kontrolünden önce gelir.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DRIVER_EVENTS, redisKeys, rideSnapshotSchema, STAND_EVENTS,
  type RideCompletedEvent, type RideCreateResult, type RideSnapshot,
} from '@duraknet/shared';
import { startRideApp, type RideApp } from './helpers/ride-app';
import {
  emitAck, errCode, north, Scope, uniqueCity, uuid, waitFor,
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
const create = (stand: StandActor, extra: Record<string, unknown>) =>
  emitAck<RideCreateResult>(stand.socket, STAND_EVENTS.rideCreate, {
    pickup: stand.location, pickupAddress: 'Test Mah. Test Sk. No:1', ...extra,
  });

async function matchRide(stand: StandActor, driver: DriverActor) {
  const { rideId } = await s.createRide(stand);
  await driver.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
  const ack = await emitAck<RideSnapshot>(driver.socket, DRIVER_EVENTS.rideAccept, { rideId });
  if (!ack.ok) throw new Error(`kabul başarısız: ${JSON.stringify(ack)}`);
  const snap = rideSnapshotSchema.parse(ack.data);
  await stand.rec.waitFor(STAND_EVENTS.rideMatched, forRide(rideId));
  return { rideId, version: snap.version };
}

describe('ride_create + clientRequestId', () => {
  it('aynı clientRequestId iki kez: tek ride, aynı {rideId, shortCode}; arama zinciri çiftlenmez', async () => {
    s = new Scope(t);
    const stand = await s.stand(uniqueCity(), { initialRadiusM: 1000, maxRadiusM: 3000 });
    const clientRequestId = uuid();
    const a = await create(stand, { clientRequestId });
    const b = await create(stand, { clientRequestId });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok || !a.data || !b.data) throw new Error('ack');
    s.rideIds.add(a.data.rideId);
    expect(b.data).toEqual(a.data);

    const rows = await t.db.selectFrom('rides').select(['id', 'short_code']).where('stand_id', '=', stand.id).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.short_code).toBe(a.data.shortCode);

    // Her dalga tek kez bildirilir: yinelenen istek ikinci bir dispatch zinciri başlatmadı.
    const evs = await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(a.data.rideId), { n: 4, ms: 15_000 });
    const waves = evs.map((e) => e.wave as number);
    expect(new Set(waves).size).toBe(waves.length);
  }, 30_000);

  it('eşzamanlı 5 istek aynı clientRequestId ile: tek ride, hepsi aynı sonucu alır', async () => {
    s = new Scope(t);
    const stand = await s.stand(uniqueCity());
    const clientRequestId = uuid();
    const acks = await Promise.all(Array.from({ length: 5 }, () => create(stand, { clientRequestId })));
    for (const a of acks) expect(a.ok, JSON.stringify(a)).toBe(true);
    const ids = new Set(acks.map((a) => (a.ok ? a.data!.rideId : '')));
    expect(ids.size).toBe(1);
    s.rideIds.add([...ids][0]!);
    const rows = await t.db.selectFrom('rides').select('id').where('stand_id', '=', stand.id).execute();
    expect(rows).toHaveLength(1);
  }, 30_000);

  it('farklı durak aynı clientRequestId kullanırsa ayrı ride açılır; id\'siz istekler her seferinde yeni ride', async () => {
    s = new Scope(t);
    const st1 = await s.stand(uniqueCity());
    const st2 = await s.stand(uniqueCity());
    const clientRequestId = uuid();
    const a = await create(st1, { clientRequestId });
    const b = await create(st2, { clientRequestId });
    if (!a.ok || !b.ok || !a.data || !b.data) throw new Error(`ack: ${JSON.stringify([a, b])}`);
    s.rideIds.add(a.data.rideId);
    s.rideIds.add(b.data.rideId);
    expect(a.data.rideId).not.toBe(b.data.rideId);

    const x = await create(st1, {});
    const y = await create(st1, {});
    if (!x.ok || !y.ok || !x.data || !y.data) throw new Error('ack');
    s.rideIds.add(x.data.rideId);
    s.rideIds.add(y.data.rideId);
    expect(x.data.rideId).not.toBe(y.data.rideId);
  }, 30_000);

  it('geçersiz clientRequestId VALIDATION_ERROR; ride oluşmaz', async () => {
    s = new Scope(t);
    const stand = await s.stand(uniqueCity());
    expect(errCode(await create(stand, { clientRequestId: 'uuid-degil' }))).toBe('VALIDATION_ERROR');
    expect(await t.db.selectFrom('rides').select('id').where('stand_id', '=', stand.id).execute()).toHaveLength(0);
  });

  it('aynı kimlik + farklı içerik (pickupAddress / pickup) CONFLICT; ride değişmez', async () => {
    s = new Scope(t);
    const stand = await s.stand(uniqueCity());
    const clientRequestId = uuid();
    const a = await create(stand, { clientRequestId });
    if (!a.ok || !a.data) throw new Error('ack');
    s.rideIds.add(a.data.rideId);
    expect(errCode(await create(stand, { clientRequestId, pickupAddress: 'Başka Sk. No:9' }))).toBe('CONFLICT');
    expect(errCode(await create(stand, { clientRequestId, pickup: north(stand.location, 5000) }))).toBe('CONFLICT');
    // Aynı içerik + açık ride: aynı sonuç.
    const same = await create(stand, { clientRequestId });
    expect(same.ok && same.data).toEqual(a.data);
    const rows = await t.db.selectFrom('rides').select(['id', 'pickup_address']).where('stand_id', '=', stand.id).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pickup_address).toBe('Test Mah. Test Sk. No:1');
  }, 30_000);

  it('ride iptal edilince aynı clientRequestId CONFLICT döner (iptal edilmiş çağrı yeniden açılmaz)', async () => {
    s = new Scope(t);
    const stand = await s.stand(uniqueCity());
    const clientRequestId = uuid();
    const a = await create(stand, { clientRequestId });
    if (!a.ok || !a.data) throw new Error('ack');
    s.rideIds.add(a.data.rideId);
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(a.data.rideId));
    const v = s.lastVersion(stand.rec, a.data.rideId);
    expect((await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId: a.data.rideId, version: v })).ok).toBe(true);
    expect(errCode(await create(stand, { clientRequestId }))).toBe('CONFLICT');
    expect(await s.rideStatus(a.data.rideId)).toBe('cancelled');
    expect(await t.db.selectFrom('rides').select('id').where('stand_id', '=', stand.id).execute()).toHaveLength(1);
  }, 30_000);

  it('tamamlanmış ride için aynı clientRequestId da CONFLICT', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const clientRequestId = uuid();
    const a = await create(stand, { clientRequestId });
    if (!a.ok || !a.data) throw new Error('ack');
    s.rideIds.add(a.data.rideId);
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(a.data.rideId), { ms: 10_000 });
    const acc = await emitAck<RideSnapshot>(d.socket, DRIVER_EVENTS.rideAccept, { rideId: a.data.rideId });
    expect(acc.ok).toBe(true);
    const snap = rideSnapshotSchema.parse(acc.ok ? acc.data : null);
    expect((await emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId: a.data.rideId, version: snap.version })).ok).toBe(true);
    expect(errCode(await create(stand, { clientRequestId }))).toBe('CONFLICT');
  }, 30_000);
});

describe('terminal geçiş tekrarları aynı sonucu döner', () => {
  it('ride_accept tekrarı: aynı şoföre zaten matched ise ok + aynı snapshot; sürüm değişmez', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId, version } = await matchRide(stand, d);
    const again = await emitAck<RideSnapshot>(d.socket, DRIVER_EVENTS.rideAccept, { rideId });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    const snap = rideSnapshotSchema.parse(again.ok ? again.data : null);
    expect(snap.status).toBe('matched');
    expect(snap.version).toBe(version);
    expect((await s.ride(rideId))?.version).toBe(version);
  }, 30_000);

  it('ride_accept: başka şoför kazanmışsa tekrar deneyen kaybeden hâlâ RIDE_NOT_AVAILABLE alır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const winner = await s.driver(north(city, 200));
    const loser = await s.driver(north(city, 300));
    const { rideId } = await s.createRide(stand);
    await winner.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    await loser.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    expect((await emitAck(winner.socket, DRIVER_EVENTS.rideAccept, { rideId })).ok).toBe(true);
    for (let i = 0; i < 2; i++) {
      expect(errCode(await emitAck(loser.socket, DRIVER_EVENTS.rideAccept, { rideId }))).toBe('RIDE_NOT_AVAILABLE');
    }
  }, 30_000);

  it('ride_complete tekrarı (şoför): ok + aynı RideCompletedEvent; eski sürümle de; PG değişmez', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId, version } = await matchRide(stand, d);
    const first = await emitAck<RideCompletedEvent>(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const after = await s.ride(rideId);
    expect(after?.status).toBe('completed');

    for (const v of [version, version - 1, (after?.version ?? 0)]) {
      const again = await emitAck<RideCompletedEvent>(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version: v });
      expect(again.ok, `version=${v}: ${JSON.stringify(again)}`).toBe(true);
      // Ack gövdesi RideCompletedEvent: tekrar da ilk tamamlamanın aynı sonucunu (rideId + completedAt) döner.
      if (again.ok && first.ok) expect(again.data).toMatchObject({ rideId, completedAt: first.data!.completedAt });
    }
    const end = await s.ride(rideId);
    expect(end?.version).toBe(after?.version);
    expect(end?.completed_at?.getTime()).toBe(after?.completed_at?.getTime());
    // Şoför tekrar available ve ride'a bağlı değil.
    expect((await s.driverHash(d.id)).status).toBe('available');
  }, 30_000);

  it('ride_complete tekrarı (durak): ok; şoför tamamladıktan sonra durak da aynı sonucu alır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId, version } = await matchRide(stand, d);
    expect((await emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version })).ok).toBe(true);
    const viaStand = await emitAck(stand.socket, STAND_EVENTS.rideComplete, { rideId, version });
    expect(viaStand.ok, JSON.stringify(viaStand)).toBe(true);
    expect((await emitAck(stand.socket, STAND_EVENTS.rideComplete, { rideId, version })).ok).toBe(true);
    expect(await s.rideStatus(rideId)).toBe('completed');
  }, 30_000);

  it('ride_cancel tekrarı: ok; ride cancelled kalır, cancelled_at ve version değişmez', async () => {
    s = new Scope(t);
    const stand = await s.stand(uniqueCity());
    const { rideId } = await s.createRide(stand);
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(rideId));
    const v = s.lastVersion(stand.rec, rideId);
    expect((await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version: v, reason: 'vazgeçti' })).ok).toBe(true);
    const row = await s.ride(rideId);
    expect(row?.status).toBe('cancelled');

    for (const ver of [v, row!.version]) {
      const again = await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version: ver });
      expect(again.ok, `version=${ver}: ${JSON.stringify(again)}`).toBe(true);
    }
    const end = await s.ride(rideId);
    expect(end?.version).toBe(row?.version);
    expect(end?.cancelled_at?.getTime()).toBe(row?.cancelled_at?.getTime());
    expect(end?.cancel_reason).toBe('vazgeçti');
  }, 30_000);

  it('ride_driver_cancel tekrarı: ride artık o şoföre ait değil ve şoför excluded ise ok; durum searching kalır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId, version } = await matchRide(stand, d);
    expect((await emitAck(d.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, version })).ok).toBe(true);
    expect(await s.waitRideStatus(rideId, 'searching')).toBe('searching');
    expect(await s.isExcluded(rideId, d.id)).toBe(true);
    const row = await s.ride(rideId);

    const again = await emitAck(d.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, version });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    const end = await s.ride(rideId);
    expect(end?.status).toBe('searching');
    expect(end?.version).toBe(row?.version);
    expect(end?.driver_id).toBeNull();
  }, 30_000);
});

describe('hedefte olmayan durumda VERSION_CONFLICT / INVALID_TRANSITION korunur', () => {
  it('matched ride için eski sürümle complete/driver_cancel VERSION_CONFLICT; searching ride için eski sürümle cancel VERSION_CONFLICT', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId, version } = await matchRide(stand, d);
    const stale = version - 1;
    expect(errCode(await emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version: stale }))).toBe('VERSION_CONFLICT');
    expect(errCode(await emitAck(d.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, version: stale }))).toBe('VERSION_CONFLICT');
    expect(await s.rideStatus(rideId)).toBe('matched');

    const other = await s.stand(uniqueCity());
    const { rideId: r2 } = await s.createRide(other);
    await other.rec.waitFor(STAND_EVENTS.rideSearching, forRide(r2));
    const v2 = s.lastVersion(other.rec, r2);
    expect(errCode(await emitAck(other.socket, STAND_EVENTS.rideCancel, { rideId: r2, version: v2 - 1 }))).toBe('VERSION_CONFLICT');
    expect(await s.rideStatus(r2)).toBe('searching');
  }, 40_000);

  it('cancelled ride tamamlanamaz, completed ride iptal edilemez (hedef durum değil): INVALID_TRANSITION', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));

    const { rideId: cancelled } = await s.createRide(stand);
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(cancelled));
    const vc = s.lastVersion(stand.rec, cancelled);
    expect((await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId: cancelled, version: vc })).ok).toBe(true);
    const rc = (await s.ride(cancelled))!;
    expect(errCode(await emitAck(stand.socket, STAND_EVENTS.rideComplete, { rideId: cancelled, version: rc.version }))).toBe('INVALID_TRANSITION');

    const { rideId, version } = await matchRide(stand, d);
    expect((await emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version })).ok).toBe(true);
    const rd = (await s.ride(rideId))!;
    expect(errCode(await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version: rd.version }))).toBe('INVALID_TRANSITION');
    expect(await s.rideStatus(rideId)).toBe('completed');
    expect(await s.rideStatus(cancelled)).toBe('cancelled');
  }, 40_000);
});

describe('yabancı hesap tekrar denemeyle sonuç öğrenemez', () => {
  it('başka durak: tamamlanmış/iptal edilmiş ride için ride_complete/ride_cancel reddedilir (ok değil)', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const owner = await s.stand(city);
    const stranger = await s.stand(uniqueCity());
    const d = await s.driver(north(city, 200));

    const { rideId, version } = await matchRide(owner, d);
    expect((await emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version })).ok).toBe(true);
    const done = (await s.ride(rideId))!;
    for (const [ev, v] of [[STAND_EVENTS.rideComplete, done.version], [STAND_EVENTS.rideCancel, done.version]] as const) {
      const ack = await emitAck(stranger.socket, ev, { rideId, version: v });
      expect(ack.ok, `${ev}: ${JSON.stringify(ack)}`).toBe(false);
      expect(['FORBIDDEN', 'NOT_FOUND']).toContain(errCode(ack));
    }

    const { rideId: r2 } = await s.createRide(owner);
    await owner.rec.waitFor(STAND_EVENTS.rideSearching, forRide(r2));
    const v2 = s.lastVersion(owner.rec, r2);
    expect((await emitAck(owner.socket, STAND_EVENTS.rideCancel, { rideId: r2, version: v2 })).ok).toBe(true);
    const cancelled = (await s.ride(r2))!;
    const ack = await emitAck(stranger.socket, STAND_EVENTS.rideCancel, { rideId: r2, version: cancelled.version });
    expect(ack.ok).toBe(false);
    expect(['FORBIDDEN', 'NOT_FOUND']).toContain(errCode(ack));
  }, 40_000);

  it('başka şoför: tamamlanmış ride için ride_complete ve ride_driver_cancel reddedilir', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const stranger = await s.driver(north(city, 400));
    const { rideId, version } = await matchRide(stand, d);
    expect((await emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version })).ok).toBe(true);
    const done = (await s.ride(rideId))!;
    for (const ev of [DRIVER_EVENTS.rideComplete, DRIVER_EVENTS.rideDriverCancel]) {
      const ack = await emitAck(stranger.socket, ev, { rideId, version: done.version });
      expect(ack.ok, `${ev}: ${JSON.stringify(ack)}`).toBe(false);
      expect(['FORBIDDEN', 'NOT_FOUND', 'INVALID_TRANSITION', 'RIDE_NOT_AVAILABLE']).toContain(errCode(ack));
    }
    // Ride değişmedi.
    expect((await s.ride(rideId))?.version).toBe(done.version);
    await waitFor(async () => (await t.redis.hget(redisKeys.driver(stranger.id), 'status')), (v) => v === 'available', 2000);
  }, 40_000);
});

describe('ride_driver_cancel idempotency: kanıt PG\'de (last_driver_cancel_by)', () => {
  it('gerçekten iptal eden şoförün tekrarı ok ve ORİJİNAL iptal sürümünü döner; sonradan başka şoföre eşleşse de aynı', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d1 = await s.driver(north(city, 200));
    const d2 = await s.driver(north(city, 300));
    const { rideId } = await s.createRide(stand);
    await d1.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    await d2.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    const acc = await emitAck<RideSnapshot>(d1.socket, DRIVER_EVENTS.rideAccept, { rideId });
    const v = rideSnapshotSchema.parse(acc.ok ? acc.data : null).version;
    const first = await emitAck<{ rideId: string; version: number }>(d1.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, version: v });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const cancelVersion = first.ok ? first.data!.version : -1;
    const row = await s.ride(rideId);
    expect(row?.last_driver_cancel_by).toBe(d1.id);
    expect(row?.last_driver_cancel_version).toBe(cancelVersion);

    // Başka şoför kabul eder: ride sürümü ilerler.
    // Ride searching'e dönünce adaylık sıfırlanır; sonraki dalga d2'yi yeniden bildirir.
    await d2.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { n: 2, ms: 10_000 });
    const acc2 = await emitAck(d2.socket, DRIVER_EVENTS.rideAccept, { rideId });
    expect(acc2.ok, JSON.stringify(acc2)).toBe(true);
    const now = (await s.ride(rideId))!;
    expect(now.status).toBe('matched');
    expect(now.version).toBeGreaterThan(cancelVersion);

    const again = await emitAck<{ rideId: string; version: number }>(d1.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, version: v });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(again.ok && again.data!.version).toBe(cancelVersion); // başkasının sonraki sürümü sızmaz
    // Ride d2'de kaldı.
    const end = await s.ride(rideId);
    expect(end?.status).toBe('matched');
    expect(end?.driver_id).toBe(d2.id);
  }, 40_000);

  it('yalnızca ret eden (decline) şoför ok ALMAZ ve sürüm sızmaz', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d1 = await s.driver(north(city, 200));
    const d2 = await s.driver(north(city, 300));
    const { rideId } = await s.createRide(stand);
    await d1.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    await d2.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    expect((await emitAck(d2.socket, DRIVER_EVENTS.rideDecline, { rideId })).ok).toBe(true);
    const acc = await emitAck<RideSnapshot>(d1.socket, DRIVER_EVENTS.rideAccept, { rideId });
    const v = rideSnapshotSchema.parse(acc.ok ? acc.data : null).version;

    for (const version of [v, v - 1, v + 5]) {
      const ack = await emitAck(d2.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, version });
      expect(ack.ok, `version=${version}: ${JSON.stringify(ack)}`).toBe(false);
      expect(['FORBIDDEN', 'INVALID_TRANSITION', 'NOT_FOUND', 'VERSION_CONFLICT']).toContain(errCode(ack));
      expect(JSON.stringify(ack)).not.toMatch(/"version"/);
    }
    const row = await s.ride(rideId);
    expect(row?.status).toBe('matched');
    expect(row?.driver_id).toBe(d1.id);
  }, 40_000);

  it('hiç ilgisi olmayan şoför başkasının matched ride\'ında FORBIDDEN/INVALID_TRANSITION alır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const owner = await s.driver(north(city, 200));
    const stranger = await s.driver(north(city, 5000));
    const { rideId, version } = await matchRide(stand, owner);
    const ack = await emitAck(stranger.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, version });
    expect(ack.ok).toBe(false);
    expect(['FORBIDDEN', 'INVALID_TRANSITION', 'NOT_FOUND']).toContain(errCode(ack));
    expect(await s.rideStatus(rideId)).toBe('matched');
  }, 40_000);

  it('iptal commit\'i ile tekrar arasındaki yarış: Redis excluded kümesi silinse bile PG kanıtıyla ok', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const { rideId, version } = await matchRide(stand, d);
    const first = await emitAck<{ version: number }>(d.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, version });
    expect(first.ok).toBe(true);
    await t.redis.del(redisKeys.rideExcluded(rideId)); // SADD'e bağımlı değil
    // Eşzamanlı çift tekrar.
    const acks = await Promise.all([
      emitAck<{ version: number }>(d.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, version }),
      emitAck<{ version: number }>(d.socket, DRIVER_EVENTS.rideDriverCancel, { rideId, version }),
    ]);
    for (const a of acks) {
      expect(a.ok, JSON.stringify(a)).toBe(true);
      expect(a.ok && a.data!.version).toBe(first.ok ? first.data!.version : -1);
    }
  }, 40_000);
});
