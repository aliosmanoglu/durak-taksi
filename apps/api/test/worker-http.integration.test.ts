// Faz 5 worker HTTP uçları (docs/design/faz5-resilience.md Bölüm 4): /health, /ready (PG + Redis + sweeper tazeliği),
// /metrics (token kuralı; küme geneli gauge'lar yalnızca worker'da). Gerçek PG + Redis; API test konteynerlerini kullanır.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { redisKeys } from '@duraknet/shared';
import { metricSum } from './helpers/metrics';
import { startRideApp, type RideApp } from './helpers/ride-app';
import { Scope, north, uniqueCity, waitFor } from './helpers/rides';
import { Registry } from 'prom-client';
import { startWorkerHttp } from '../../worker/src/http';
import { startWorkerHttpForTest, type WorkerHttpHandle } from './helpers/worker-http';

let t: RideApp;
let s: Scope;
let w: WorkerHttpHandle;
const TOKEN = 'worker-metrik-token-123';

beforeAll(async () => {
  // Dispatch'i gerçek worker (startWorker) yürütür; ikinci bir ride worker'ı gerekmez.
  t = await startRideApp({ workers: false });
  w = await startWorkerHttpForTest(t, { metricsToken: TOKEN });
});
afterEach(() => s?.cleanup());
afterAll(async () => {
  await w?.close();
  await t?.close();
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${w.url}${path}`, { headers });
const scrape = async () => {
  const res = await get('/metrics', { Authorization: `Bearer ${TOKEN}` });
  expect(res.status).toBe(200);
  return res.text();
};

describe('worker /health ve /ready', () => {
  it('/health 200', async () => {
    expect((await get('/health')).status).toBe(200);
  });

  it('/ready: PG + Redis erişilebilir ve sweeper tiki taze ise 200; tik bayatsa 503', async () => {
    // İlk sweeper tiki gelmiş olsun (sonraki 1 saat sonra): değeri artık yalnızca bu test değiştirir.
    await waitFor(() => t.redis.get(redisKeys.sweeperLastTick), (v) => v !== null, 15_000);
    await t.redis.set(redisKeys.sweeperLastTick, String(Date.now()));
    expect((await get('/ready')).status).toBe(200);

    await t.redis.set(redisKeys.sweeperLastTick, String(Date.now() - 6 * 60 * 60 * 1000));
    const stale = await get('/ready');
    expect(stale.status).toBe(503);

    await t.redis.set(redisKeys.sweeperLastTick, String(Date.now()));
    expect((await get('/ready')).status).toBe(200);
  });
});

describe('worker /metrics', () => {
  it('token zorunlu: eksik/yanlış token 401, doğru token 200', async () => {
    expect((await get('/metrics')).status).toBe(401);
    expect((await get('/metrics', { Authorization: 'Bearer yanlis' })).status).toBe(401);
    const ok = await get('/metrics', { Authorization: `Bearer ${TOKEN}` });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('process_cpu_seconds_total');
  });

  it('duraknet_drivers_active{status} Redis varlığını yansıtır (available / online / busy)', async () => {
    s = new Scope(t);
    const before = await scrape();
    const city = uniqueCity();
    await s.driver(north(city, 100));
    await s.driver(north(city, 200));
    const text = await waitFor(
      scrape,
      (x) => metricSum(x, 'duraknet_drivers_active', { status: 'available' }) >= metricSum(before, 'duraknet_drivers_active', { status: 'available' }) + 2,
      8000,
    );
    expect(metricSum(text, 'duraknet_drivers_active', { status: 'online' })).toBeGreaterThanOrEqual(
      metricSum(text, 'duraknet_drivers_active', { status: 'available' }),
    );
    expect(metricSum(text, 'duraknet_drivers_active', { status: 'busy' })).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('duraknet_open_rides{status} açık searching çağrıları sayar', async () => {
    s = new Scope(t);
    const before = await scrape();
    const stand = await s.stand(uniqueCity());
    await s.createRide(stand);
    await s.createRide(stand);
    // PG sayımı kısa süre önbelleklenir (10 sn): sınır içinde bekle.
    const text = await waitFor(
      scrape,
      (x) => metricSum(x, 'duraknet_open_rides', { status: 'searching' }) >= metricSum(before, 'duraknet_open_rides', { status: 'searching' }) + 2,
      15_000,
      250,
    );
    expect(metricSum(text, 'duraknet_open_rides', { status: 'searching' })).toBeGreaterThanOrEqual(2);
  }, 40_000);

  it('token tanımsız (allowAnon yok): /metrics her ortamda kapalı (404); kapanış bayrağı /ready yi 503 yapar', async () => {
    let closing = false;
    const h = await startWorkerHttp({
      port: 0, registry: new Registry(), allowAnon: false,
      readiness: async () => ({ ok: true, checks: {} }),
      isShuttingDown: () => closing,
    });
    try {
      const base = `http://127.0.0.1:${h.port}`;
      expect((await fetch(`${base}/metrics`)).status).toBe(404);
      expect((await fetch(`${base}/ready`)).status).toBe(200);
      closing = true;
      expect((await fetch(`${base}/ready`)).status).toBe(503);
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('küme gauge\'ları API /metrics çıktısında YOK (çift sayım olmasın)', async () => {
    const res = await t.http().get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/^duraknet_drivers_active/m);
    expect(res.text).not.toMatch(/^duraknet_open_rides/m);
  });
});
