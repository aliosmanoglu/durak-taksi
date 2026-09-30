// Faz 3 testleri için uygulama + dispatch worker kurulumu. Backend bağlantı noktaları tek yerde toplanır:
// backend'in kurulum imzası değişirse yalnızca burası güncellenir.
//
// Üretimdeki topoloji korunur: API yalnızca BullMQ'ya job ekler (createDispatchScheduler); dalga/hatırlatma
// işleme worker'dadır (startRideWorkers) ve istemcilere redis-emitter ile API'deki redis-adapter üzerinden yayın yapar.
// Testte worker aynı süreçte, kısaltılmış sürelerle ve testin PG/Redis'ine bağlı çalışır. Bu yüzden her ride
// testi `redisAdapter: true` ile kurulur (emitter adapter kanallarına yazar).
import { Redis } from 'ioredis';
import pino from 'pino';
import { createWorkerEmitter } from '../../../worker/src/rides/emitter';
import { startRideWorkers, type RideWorkers } from '../../../worker/src/rides/workers';
import { createDispatchScheduler } from '../../src/rides/scheduler';
import { startTestApp, type StartTestAppOptions, type TestApp } from './app';
import { inject } from 'vitest';

/** Kısaltılmış dispatch/hatırlatma süreleri (ms). Gerçek bekleme yerine testler kısa aralıklarla koşar. */
export const FAST_TIMING = {
  waveDelaysMs: [300, 300, 300] as number[],
  continuousScanMs: 300,
  reminderFirstMs: 1200,
  reminderEveryMs: 800,
  locationFreshMs: 30_000,
};
export type Timing = typeof FAST_TIMING;

export type RideApp = TestApp & { timing: Timing };

export async function startRideApp(opts: Omit<StartTestAppOptions, 'scheduler'> & { timing?: Partial<Timing> } = {}): Promise<RideApp> {
  const timing: Timing = { ...FAST_TIMING, ...opts.timing };
  const url = inject('redisUrl');
  const bullConnection = new Redis(url, { maxRetriesPerRequest: null });
  const workerBull = new Redis(url, { maxRetriesPerRequest: null });
  const workerRedis = new Redis(url, { maxRetriesPerRequest: 1 });
  const subscriber = new Redis(url, { maxRetriesPerRequest: null });
  const emitterRedis = new Redis(url, { maxRetriesPerRequest: null });
  const scheduler = createDispatchScheduler(bullConnection, { reminderFirstMs: timing.reminderFirstMs });

  const t = await startTestApp({ redisAdapter: true, ...opts, scheduler });

  let workers: RideWorkers | undefined;
  try {
    workers = await startRideWorkers({
      pool: t.pool,
      redis: workerRedis,
      bullConnection: workerBull,
      emitter: createWorkerEmitter(emitterRedis),
      log: pino({ level: 'silent' }),
      subscriber,
      nearby: false,
      timing: {
        waveDelaysMs: timing.waveDelaysMs,
        continuousScanMs: timing.continuousScanMs,
        reminderEveryMs: timing.reminderEveryMs,
        nearbyEveryMs: 10_000,
        locationFreshMs: timing.locationFreshMs,
      },
    });
  } catch (err) {
    await t.close();
    throw err;
  }

  const close = t.close;
  return Object.assign(t, {
    timing,
    async close() {
      await workers?.close();
      await scheduler.close();
      await close();
      await Promise.allSettled([bullConnection, workerBull, workerRedis, subscriber, emitterRedis].map((r) => r.quit()));
    },
  });
}
