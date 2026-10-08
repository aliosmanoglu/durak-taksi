// Faz 5 metrikler (docs/design/faz5-resilience.md Bölüm 4): API GET /metrics, token kuralı, sayaç/histogram güncellemeleri.
// Sayaçlar süreç genelinde birikebildiğinden her test önce/sonra farkı (delta) ölçer.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DRIVER_EVENTS, STAND_EVENTS } from '@duraknet/shared';
import { metricSum } from './helpers/metrics';
import { startTestApp, type TestApp } from './helpers/app';
import { startRideApp, type RideApp } from './helpers/ride-app';
import { emitAck, north, Scope, sleep, uniqueCity, waitFor } from './helpers/rides';

describe('GET /metrics (açık, METRICS_TOKEN yok)', () => {
  let t: RideApp;
  let s: Scope;
  beforeAll(async () => {
    t = await startRideApp();
  });
  afterEach(() => s?.cleanup());
  afterAll(() => t.close());

  const scrape = async () => {
    const res = await t.http().get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    return res.text;
  };

  it('Prometheus metni döner; işlem metrikleri ve Faz 5 metrik aileleri tanımlıdır', async () => {
    const text = await scrape();
    expect(text).toContain('process_cpu_seconds_total');
    for (const name of [
      'duraknet_location_update_seconds', 'duraknet_rides_total', 'duraknet_match_seconds',
      'duraknet_socket_connections', 'duraknet_rate_limited_total', 'duraknet_rate_limit_errors_total',
    ]) {
      expect(text, `${name} # TYPE satırı yok`).toMatch(new RegExp(`^# TYPE ${name} `, 'm'));
    }
  });

  it('çağrı yaşam döngüsü ride sayaçlarını ve match_seconds histogramını günceller', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city);
    const d = await s.driver(north(city, 200));
    const before = await scrape();

    const { rideId } = await s.createRide(stand);
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, (e) => e.rideId === rideId, { ms: 10_000 });
    const acc = await emitAck<{ version: number }>(d.socket, DRIVER_EVENTS.rideAccept, { rideId });
    expect(acc.ok).toBe(true);
    const version = acc.ok ? acc.data!.version : 0;
    expect((await emitAck(d.socket, DRIVER_EVENTS.rideComplete, { rideId, version })).ok).toBe(true);

    const text = await waitFor(scrape, (x) => metricSum(x, 'duraknet_rides_total', { event: 'completed' }) > metricSum(before, 'duraknet_rides_total', { event: 'completed' }), 3000);
    for (const event of ['created', 'matched', 'completed']) {
      const delta = metricSum(text, 'duraknet_rides_total', { event }) - metricSum(before, 'duraknet_rides_total', { event });
      expect(delta, `rides_total{event=${event}}`).toBe(1);
    }
    const cnt = metricSum(text, 'duraknet_match_seconds_count') - metricSum(before, 'duraknet_match_seconds_count');
    expect(cnt).toBe(1);
    // Eşleşme süresi makul: bu testte saniyeler içinde (hedef < 60 sn).
    const sumDelta = metricSum(text, 'duraknet_match_seconds_sum') - metricSum(before, 'duraknet_match_seconds_sum');
    expect(sumDelta).toBeGreaterThanOrEqual(0);
    expect(sumDelta).toBeLessThan(60);
  }, 40_000);

  it('iptal edilen çağrı rides_total{event="cancelled"} sayacını artırır; tekrar iptal (idempotent) iki kez saymaz', async () => {
    s = new Scope(t);
    const stand = await s.stand(uniqueCity());
    const before = await scrape();
    const { rideId } = await s.createRide(stand);
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, (e) => e.rideId === rideId);
    const v = s.lastVersion(stand.rec, rideId);
    expect((await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version: v })).ok).toBe(true);
    await emitAck(stand.socket, STAND_EVENTS.rideCancel, { rideId, version: v }); // tekrar
    const text = await scrape();
    expect(metricSum(text, 'duraknet_rides_total', { event: 'cancelled' }) - metricSum(before, 'duraknet_rides_total', { event: 'cancelled' })).toBe(1);
  }, 30_000);

  it('driver_location_update işlenince duraknet_location_update_seconds histogramı artar', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const d = await s.driver(north(city, 100));
    const before = await scrape();
    await sleep(1100); // go_online konum throttle'ını tüketmiş olabilir
    d.socket.emit(DRIVER_EVENTS.locationUpdate, { location: north(city, 150), ts: Date.now() });
    const text = await waitFor(
      scrape,
      (x) => metricSum(x, 'duraknet_location_update_seconds_count') > metricSum(before, 'duraknet_location_update_seconds_count'),
      3000,
    );
    expect(metricSum(text, 'duraknet_location_update_seconds_bucket', { le: '+Inf' })).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('duraknet_socket_connections bağlanınca artar, kopunca azalır', async () => {
    const t0 = await scrape();
    const base = metricSum(t0, 'duraknet_socket_connections');
    const a = await t.approvedDriver();
    const sock = await t.connectOk('/driver', a.tokens.accessToken);
    const up = await waitFor(scrape, (x) => metricSum(x, 'duraknet_socket_connections') >= base + 1, 3000);
    expect(metricSum(up, 'duraknet_socket_connections')).toBeGreaterThanOrEqual(base + 1);
    sock.close();
    await waitFor(scrape, (x) => metricSum(x, 'duraknet_socket_connections') <= base, 5000);
    await t.cleanup();
  }, 20_000);

  it('/metrics hız sınırından muaftır', async () => {
    for (let i = 0; i < 5; i++) expect((await t.http().get('/metrics')).status).toBe(200);
  });
});

describe('METRICS_TOKEN kuralı', () => {
  let t: TestApp;
  const TOKEN = 'metrik-gizli-token-123';
  beforeAll(async () => {
    t = await startTestApp({ appExtras: { metricsToken: TOKEN } });
  });
  afterAll(() => t.close());

  it('token tanımlıysa Authorization: Bearer zorunlu; yanlış/eksik token reddedilir', async () => {
    expect([401, 403]).toContain((await t.http().get('/metrics')).status);
    expect([401, 403]).toContain((await t.http().get('/metrics').set('Authorization', 'Bearer yanlis')).status);
    expect([401, 403]).toContain((await t.http().get('/metrics').set('Authorization', TOKEN)).status);
    const ok = await t.http().get('/metrics').set('Authorization', `Bearer ${TOKEN}`);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('process_cpu_seconds_total');
  });

  it('/health ve /ready token istemez', async () => {
    expect((await t.http().get('/health')).status).toBe(200);
    expect((await t.http().get('/ready')).status).toBe(200);
  });
});

describe('METRICS_TOKEN yok', () => {
  it('token tanımsız ve metricsAllowAnon kapalı: /metrics HER ortamda 404 (NODE_ENV=test dahil)', async () => {
    const t = await startTestApp({ appExtras: { metricsAllowAnon: false } });
    try {
      const res = await t.http().get('/metrics');
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('process_cpu_seconds_total');
      expect((await t.http().get('/health')).status).toBe(200);
    } finally {
      await t.close();
    }
  });

  it('metricsAllowAnon açıkken token olmadan okunur (açık geliştirme modu)', async () => {
    const t = await startTestApp({ appExtras: { metricsAllowAnon: true } });
    try {
      expect((await t.http().get('/metrics')).status).toBe(200);
    } finally {
      await t.close();
    }
  });
});
