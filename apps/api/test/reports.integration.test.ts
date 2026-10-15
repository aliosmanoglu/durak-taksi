// Faz 6: GET /admin/reports/daily. Gerçek PG; rides satırları doğrudan, kontrollü zaman damgalarıyla eklenir.
// Gün = rides.created_at'in Europe/Istanbul günü (UTC+3, DST yok). Tarihler 2031'de: başka testlerin verisiyle karışmaz.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dailyReportSchema, MATCH_TARGET_SECONDS, REPORT_MAX_DAYS, REPORT_TIMEZONE, type DailyReport } from '@duraknet/shared';
import { startTestApp, type TestApp } from './helpers/app';
import { deleteRidesOf, plusSec, seedRide } from './helpers/pg-rides';

let t: TestApp;
const standIds: string[] = [];
beforeAll(async () => {
  t = await startTestApp();
});
afterEach(async () => {
  await deleteRidesOf(t, standIds);
  standIds.length = 0;
  await t.cleanup();
});
afterAll(async () => {
  await t?.close();
});

async function stand() {
  const s = await t.registerStand();
  standIds.push(s.id);
  return s;
}
async function getReport(query: Record<string, string>, token?: string) {
  const tok = token ?? (await t.adminToken());
  return t.http().get('/admin/reports/daily').query(query).set('Authorization', `Bearer ${tok}`);
}
async function report(query: Record<string, string>) {
  const res = await getReport(query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.ok).toBe(true);
  return dailyReportSchema.parse(res.body.data) as DailyReport;
}

describe('günlük rapor', () => {
  it('gün sınırı (TR), durum karışımı, süre istatistikleri ve boş gün', async () => {
    const s = await stand();
    // Gün 2031-03-10 (TR): 2031-03-09T21:00:00Z .. 2031-03-10T20:59:59Z
    // Gün 2031-03-11 (TR): 2031-03-10T21:00:00Z .. 2031-03-11T20:59:59Z
    const d1First = '2031-03-09T21:00:01Z'; // TR 00:00:01 -> 10 Mart
    const d1Last = '2031-03-10T20:59:59Z'; // TR 23:59:59 -> 10 Mart
    const d2First = '2031-03-10T21:00:01Z'; // TR 00:00:01 -> 11 Mart
    const base = { standId: s.id };

    // 10 Mart: tamamlanan (10 sn), iptal (hiç eşleşmedi), şoför iptali sonrası yeniden eşleşen tamamlanan (40 sn)
    await seedRide(t, { ...base, status: 'completed', createdAt: d1First, searchingAt: plusSec(d1First, 1), matchedAt: plusSec(d1First, 11), completedAt: plusSec(d1First, 300) });
    await seedRide(t, { ...base, status: 'cancelled', createdAt: d1Last, searchingAt: plusSec(d1Last, 0), cancelledAt: plusSec(d1Last, 30) });
    const re = '2031-03-10T12:00:00Z';
    await seedRide(t, { ...base, status: 'completed', createdAt: plusSec(re, -5), searchingAt: re, matchedAt: plusSec(re, 40), completedAt: plusSec(re, 600) });
    // 11 Mart: eşleşmiş açık (28 sn), tamamlanan (90 sn), aranıyor
    await seedRide(t, { ...base, status: 'matched', createdAt: d2First, searchingAt: plusSec(d2First, 1), matchedAt: plusSec(d2First, 29) });
    await seedRide(t, { ...base, status: 'completed', createdAt: d2First, searchingAt: plusSec(d2First, 1), matchedAt: plusSec(d2First, 91), completedAt: plusSec(d2First, 400) });
    await seedRide(t, { ...base, status: 'searching', createdAt: d2First, searchingAt: plusSec(d2First, 1) });

    const r = await report({ from: '2031-03-10', to: '2031-03-12', standId: s.id });
    expect(r.timezone).toBe(REPORT_TIMEZONE);
    expect(r.targetSeconds).toBe(MATCH_TARGET_SECONDS);
    expect(r.days.map((d) => d.date)).toEqual(['2031-03-10', '2031-03-11', '2031-03-12']);

    const [d1, d2, d3] = r.days;
    expect(d1).toMatchObject({ total: 3, matched: 2, completed: 2, cancelled: 1, open: 0, withinTargetRate: 1 });
    expect(d1!.matchRate).toBeCloseTo(2 / 3, 5);
    expect(d1!.avgMatchSeconds).toBeCloseTo(25, 1);
    expect(d1!.medianMatchSeconds).toBeCloseTo(25, 1);
    expect(d1!.p90MatchSeconds).toBeCloseTo(37, 1);

    expect(d2).toMatchObject({ total: 3, matched: 2, completed: 1, cancelled: 0, open: 2, withinTargetRate: 0.5 });
    expect(d2!.matchRate).toBeCloseTo(2 / 3, 5);
    expect(d2!.avgMatchSeconds).toBeCloseTo(59, 1);
    expect(d2!.medianMatchSeconds).toBeCloseTo(59, 1);
    expect(d2!.p90MatchSeconds).toBeCloseTo(83.8, 1);

    // Boş gün satır olarak döner; oran/süre null.
    expect(d3).toEqual({
      date: '2031-03-12', total: 0, matched: 0, completed: 0, cancelled: 0, open: 0,
      matchRate: null, avgMatchSeconds: null, medianMatchSeconds: null, p90MatchSeconds: null, withinTargetRate: null,
    });

    // Toplam: ride bazında yeniden hesaplanır (süreler 10,28,40,90): günlük ortalamaların ortalaması (42) ile
    // medyan (34) ve p90 (75) ayırt edilir.
    expect(r.totals).toMatchObject({ total: 6, matched: 4, completed: 3, cancelled: 1, open: 2, withinTargetRate: 0.75 });
    expect(r.totals.matchRate).toBeCloseTo(4 / 6, 5);
    expect(r.totals.avgMatchSeconds).toBeCloseTo(42, 1);
    expect(r.totals.medianMatchSeconds).toBeCloseTo(34, 1);
    expect(r.totals.p90MatchSeconds).toBeCloseTo(75, 1);
  });

  it('UTC gün sınırı değil TR gün sınırı kullanılır (UTC 21:00 öncesi/sonrası)', async () => {
    const s = await stand();
    // Her ikisi de UTC'de 2031-04-10; TR'de biri 10 Nisan, diğeri 11 Nisan.
    await seedRide(t, { standId: s.id, status: 'searching', createdAt: '2031-04-10T20:59:59Z', searchingAt: '2031-04-10T20:59:59Z' });
    await seedRide(t, { standId: s.id, status: 'searching', createdAt: '2031-04-10T21:00:00Z', searchingAt: '2031-04-10T21:00:00Z' });
    const r = await report({ from: '2031-04-10', to: '2031-04-11', standId: s.id });
    expect(r.days.map((d) => [d.date, d.total])).toEqual([['2031-04-10', 1], ['2031-04-11', 1]]);
  });

  it('durak filtresi: başka duraktaki çağrılar sayılmaz; filtresiz rapor ikisini de içerir', async () => {
    const a = await stand();
    const b = await stand();
    const at = '2031-05-10T09:00:00Z';
    await seedRide(t, { standId: a.id, status: 'completed', createdAt: at, searchingAt: at, matchedAt: plusSec(at, 20), completedAt: plusSec(at, 200) });
    await seedRide(t, { standId: b.id, status: 'cancelled', createdAt: at, searchingAt: at, cancelledAt: plusSec(at, 20) });
    await seedRide(t, { standId: b.id, status: 'cancelled', createdAt: at, searchingAt: at, cancelledAt: plusSec(at, 20) });

    const ra = await report({ from: '2031-05-10', to: '2031-05-10', standId: a.id });
    expect(ra.totals).toMatchObject({ total: 1, completed: 1, cancelled: 0 });
    const rb = await report({ from: '2031-05-10', to: '2031-05-10', standId: b.id });
    expect(rb.totals).toMatchObject({ total: 2, completed: 0, cancelled: 2, matched: 0, matchRate: 0, avgMatchSeconds: null });
    const all = await report({ from: '2031-05-10', to: '2031-05-10' });
    expect(all.totals.total).toBeGreaterThanOrEqual(3);
    expect(all.totals.cancelled).toBeGreaterThanOrEqual(2);
  });

  it("şoför iptali sonrası yeniden aramada süre son searching_at'ten ölçülür; matched_at < searching_at süreye girmez", async () => {
    const s = await stand();
    const created = '2031-06-10T08:00:00Z';
    // İlk arama 08:00:00, şoför iptali, yeniden arama 08:10:00, eşleşme 08:10:25 -> 25 sn (10 dk 25 sn değil).
    await seedRide(t, { standId: s.id, status: 'matched', createdAt: created, searchingAt: '2031-06-10T08:10:00Z', matchedAt: '2031-06-10T08:10:25Z' });
    // Tutarsız satır: matched_at searching_at'ten önce. matched sayılır ama süre istatistiğine girmez.
    await seedRide(t, { standId: s.id, status: 'matched', createdAt: created, searchingAt: '2031-06-10T08:30:00Z', matchedAt: '2031-06-10T08:29:00Z' });
    const r = await report({ from: '2031-06-10', to: '2031-06-10', standId: s.id });
    expect(r.totals).toMatchObject({ total: 2, matched: 2, open: 2 });
    expect(r.totals.avgMatchSeconds).toBeCloseTo(25, 1);
    expect(r.totals.medianMatchSeconds).toBeCloseTo(25, 1);
    expect(r.totals.withinTargetRate).toBe(1);
  });

  it('hiç ride olmayan aralık: tüm günler sıfır satır, totals oranları null', async () => {
    const s = await stand();
    const r = await report({ from: '2031-07-01', to: '2031-07-03', standId: s.id });
    expect(r.days).toHaveLength(3);
    expect(r.totals).toMatchObject({ total: 0, matched: 0, matchRate: null, avgMatchSeconds: null, withinTargetRate: null });
  });

  it('from = to tek gün; en çok REPORT_MAX_DAYS gün kabul edilir, bir fazlası 400', async () => {
    const s = await stand();
    const one = await report({ from: '2031-08-01', to: '2031-08-01', standId: s.id });
    expect(one.days).toHaveLength(1);

    // 2031-01-01 .. 2031-04-02 = 92 gün
    const max = await report({ from: '2031-01-01', to: '2031-04-02', standId: s.id });
    expect(max.days).toHaveLength(REPORT_MAX_DAYS);

    const over = await getReport({ from: '2031-01-01', to: '2031-04-03', standId: s.id });
    expect(over.status).toBe(400);
    expect(over.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('geçersiz sorgular 400 VALIDATION_ERROR', async () => {
    for (const q of [
      {},
      { from: '2031-08-01' },
      { from: '2031-08-02', to: '2031-08-01' },
      { from: '01.08.2031', to: '02.08.2031' },
      { from: '2031-08-01', to: '2031-08-02', standId: 'degil-uuid' },
    ]) {
      const res = await getReport(q as Record<string, string>);
      expect(res.status, JSON.stringify(q)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it("yetki: token yok 401; durak ve şoför token'ı 403; admin 200", async () => {
    const q = { from: '2031-09-01', to: '2031-09-01' };
    const none = await t.http().get('/admin/reports/daily').query(q);
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('UNAUTHORIZED');

    const st = await t.approvedStand();
    const asStand = await getReport(q, st.tokens.accessToken);
    expect(asStand.status).toBe(403);
    expect(asStand.body.error.code).toBe('FORBIDDEN');

    const dr = await t.approvedDriver();
    const asDriver = await getReport(q, dr.tokens.accessToken);
    expect(asDriver.status).toBe(403);

    const bad = await t.http().get('/admin/reports/daily').query(q).set('Authorization', 'Bearer sahte.token.x');
    expect(bad.status).toBe(401);

    expect((await getReport(q)).status).toBe(200);
  });
});
