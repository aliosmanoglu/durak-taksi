// Faz 6: GET /admin/reports/consistency ("kayıp çağrı sıfır" kanıtı). PG ride'ları doğrudan eklenir, Redis hash'leri
// elle bozulur; her `kind` için bir senaryo. Rapor salt okunurdur: Redis/PG'yi değiştirmemelidir.
// (Entegrasyon dosyaları seri koşar; yine de yalnızca bu testin ride id'leri üzerinden doğrulanır.)
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { consistencyReportSchema, redisKeys, RIDE_HASH, type ConsistencyReport } from '@duraknet/shared';
import { startTestApp, type TestApp } from './helpers/app';
import { deleteRidesOf, seedRide } from './helpers/pg-rides';

let t: TestApp;
const standIds: string[] = [];
const rideIds: string[] = [];
beforeAll(async () => {
  t = await startTestApp();
});
afterEach(async () => {
  if (rideIds.length) await t.redis.del(...rideIds.map((id) => redisKeys.ride(id)));
  rideIds.length = 0;
  await deleteRidesOf(t, standIds);
  standIds.length = 0;
  await t.cleanup();
});
afterAll(async () => {
  await t?.close();
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function stand() {
  const s = await t.registerStand();
  standIds.push(s.id);
  return s;
}
async function ride(standId: string, status: Parameters<typeof seedRide>[1]['status'], extra: Partial<Parameters<typeof seedRide>[1]> = {}) {
  const r = await seedRide(t, { standId, status, createdAt: minutesAgo(10), searchingAt: minutesAgo(10), ...extra });
  rideIds.push(r.id);
  return r;
}
const hash = (rideId: string, fields: Record<string, string>) => t.redis.hset(redisKeys.ride(rideId), fields);

async function consistency() {
  const res = await t.http().get('/admin/reports/consistency').set('Authorization', `Bearer ${await t.adminToken()}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return consistencyReportSchema.parse(res.body.data) as ConsistencyReport;
}
const issuesOf = (r: ConsistencyReport, id: string) => r.issues.filter((i) => i.rideId === id);

describe('tutarlılık raporu', () => {
  it('tutarlı açık ve kapalı ride için sorun üretmez; openRides açık ride sayısını içerir', async () => {
    const s = await stand();
    const open = await ride(s.id, 'searching');
    await hash(open.id, { [RIDE_HASH.status]: 'searching', [RIDE_HASH.standId]: s.id });
    const done = await ride(s.id, 'completed', { matchedAt: minutesAgo(9), completedAt: minutesAgo(8) });
    await hash(done.id, { [RIDE_HASH.status]: 'completed' });
    // Redis'te hiç izi olmayan eski terminal ride de sorun değildir (hash TTL ile silinir).
    const old = await ride(s.id, 'cancelled', { cancelledAt: minutesAgo(180) });

    const r = await consistency();
    expect(r.openRides).toBeGreaterThanOrEqual(1);
    expect(() => new Date(r.checkedAt).toISOString()).not.toThrow();
    for (const id of [open.id, done.id, old.id]) expect(issuesOf(r, id)).toEqual([]);
  });

  it('pg_open_redis_missing: PG açık, Redis hash yok', async () => {
    const s = await stand();
    const lost = await ride(s.id, 'searching');
    const r = await consistency();
    const issues = issuesOf(r, lost.id);
    expect(issues.map((i) => i.kind)).toContain('pg_open_redis_missing');
    const i = issues.find((x) => x.kind === 'pg_open_redis_missing')!;
    expect(i).toMatchObject({ shortCode: lost.shortCode, pgStatus: 'searching', redisStatus: null });
    expect(i.ageSeconds).toBeGreaterThanOrEqual(500);
  });

  it('status_mismatch: PG searching, Redis matched', async () => {
    const s = await stand();
    const r1 = await ride(s.id, 'searching');
    await hash(r1.id, { [RIDE_HASH.status]: 'matched', [RIDE_HASH.driverId]: 'baska-sofor' });
    const issues = issuesOf(await consistency(), r1.id);
    const i = issues.find((x) => x.kind === 'status_mismatch');
    expect(i, JSON.stringify(issues)).toBeTruthy();
    expect(i).toMatchObject({ pgStatus: 'searching', redisStatus: 'matched' });
  });

  it('driver_mismatch: PG matched A şoförüyle, Redis hash başka şoförü gösteriyor', async () => {
    const s = await stand();
    const a = await t.registerDriver();
    const r1 = await ride(s.id, 'matched', { driverId: a.id, matchedAt: minutesAgo(9) });
    await hash(r1.id, { [RIDE_HASH.status]: 'matched', [RIDE_HASH.driverId]: '00000000-0000-4000-8000-000000000001' });
    try {
      const issues = issuesOf(await consistency(), r1.id);
      const i = issues.find((x) => x.kind === 'driver_mismatch');
      expect(i, JSON.stringify(issues)).toBeTruthy();
      expect(i).toMatchObject({ pgStatus: 'matched', redisStatus: 'matched' });
      // Durum aynı olduğundan status_mismatch üretilmemeli.
      expect(issues.some((x) => x.kind === 'status_mismatch')).toBe(false);
    } finally {
      await deleteRidesOf(t, standIds); // driver FK'si: şoför silinmeden ride gitsin
    }
  });

  it('stale_created: created ve RECONCILE_ORPHAN_AGE_S\'den eski; taze created sorun değildir', async () => {
    const s = await stand();
    const stale = await ride(s.id, 'created', { searchingAt: null, createdAt: minutesAgo(10) });
    await hash(stale.id, { [RIDE_HASH.status]: 'created' });
    const fresh = await ride(s.id, 'created', { searchingAt: null, createdAt: new Date(Date.now() - 2000).toISOString() });
    await hash(fresh.id, { [RIDE_HASH.status]: 'created' });

    const r = await consistency();
    const i = issuesOf(r, stale.id).find((x) => x.kind === 'stale_created');
    expect(i, JSON.stringify(issuesOf(r, stale.id))).toBeTruthy();
    expect(i!.ageSeconds).toBeGreaterThanOrEqual(500);
    expect(issuesOf(r, fresh.id)).toEqual([]);
  });

  it('redis_open_pg_closed: PG terminal (son 1 saat), Redis hâlâ açık; 1 saatten eski terminal taranmaz', async () => {
    const s = await stand();
    const recent = await ride(s.id, 'cancelled', { cancelledAt: minutesAgo(5) });
    await hash(recent.id, { [RIDE_HASH.status]: 'searching' });
    const recentMatched = await ride(s.id, 'completed', { matchedAt: minutesAgo(9), completedAt: minutesAgo(5) });
    await hash(recentMatched.id, { [RIDE_HASH.status]: 'matched' });
    const ancient = await ride(s.id, 'cancelled', { createdAt: minutesAgo(600), searchingAt: minutesAgo(600), cancelledAt: minutesAgo(500) });
    await hash(ancient.id, { [RIDE_HASH.status]: 'searching' });

    const r = await consistency();
    for (const [id, redisStatus, pgStatus] of [[recent.id, 'searching', 'cancelled'], [recentMatched.id, 'matched', 'completed']] as const) {
      const i = issuesOf(r, id).find((x) => x.kind === 'redis_open_pg_closed');
      expect(i, id).toBeTruthy();
      expect(i).toMatchObject({ pgStatus, redisStatus });
    }
    expect(issuesOf(r, ancient.id)).toEqual([]);
  });

  it('salt okunur: rapor Redis hash\'ini ve PG durumunu değiştirmez', async () => {
    const s = await stand();
    const r1 = await ride(s.id, 'searching');
    await hash(r1.id, { [RIDE_HASH.status]: 'matched', [RIDE_HASH.driverId]: 'x' });
    const before = await t.redis.hgetall(redisKeys.ride(r1.id));
    await consistency();
    await consistency();
    expect(await t.redis.hgetall(redisKeys.ride(r1.id))).toEqual(before);
    const row = await t.db.selectFrom('rides').select(['status', 'version']).where('id', '=', r1.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('searching');
  });

  it('yetki: token yok 401, durak 403', async () => {
    expect((await t.http().get('/admin/reports/consistency')).status).toBe(401);
    const st = await t.approvedStand();
    const res = await t.http().get('/admin/reports/consistency').set('Authorization', `Bearer ${st.tokens.accessToken}`);
    expect(res.status).toBe(403);
    const dr = await t.approvedDriver();
    expect((await t.http().get('/admin/reports/consistency').set('Authorization', `Bearer ${dr.tokens.accessToken}`)).status).toBe(403);
  });
});
