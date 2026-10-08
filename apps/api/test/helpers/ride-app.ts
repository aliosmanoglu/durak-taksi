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
import { createPushNotifier } from '../../src/push/notifier';
import { createDispatchScheduler, type DispatchScheduler } from '../../src/rides/scheduler';
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

export type RideAppOptions = Omit<StartTestAppOptions, 'scheduler'> & {
  timing?: Partial<Timing>;
  /** Hata enjeksiyonu: API'nin kullandığı scheduler'ı sarar (worker kendi kuyruğunu kullanır). */
  wrapScheduler?: (inner: DispatchScheduler) => DispatchScheduler;
  /** `stand_nearby_drivers` job scheduler'ı kurulsun mu (varsayılan false) ve aralığı (ms). */
  nearby?: boolean;
  nearbyEveryMs?: number;
  /** Worker timing'ine eklenen ek alanlar (ör. uzlaştırıcı aralığı); backend adı bilinen alanlar için. */
  extraWorkerTiming?: Record<string, number>;
  /**
   * Faz 5: worker'ı hiç başlatma (ikinci API node'u için; dispatch'i ilk örneğin worker'ı yürütür).
   * Varsayılan true.
   */
  workers?: boolean;
  /** Faz 5: startRideWorkers seçeneklerine eklenir (ör. `{ push: new FakePushSender() }`). */
  workerExtras?: Record<string, unknown>;
};

export async function startRideApp(opts: RideAppOptions = {}): Promise<RideApp> {
  const timing: Timing = { ...FAST_TIMING, ...opts.timing };
  const url = inject('redisUrl');
  const bullConnection = new Redis(url, { maxRetriesPerRequest: null });
  const workerBull = new Redis(url, { maxRetriesPerRequest: null });
  const workerRedis = new Redis(url, { maxRetriesPerRequest: 1 });
  const subscriber = new Redis(url, { maxRetriesPerRequest: null });
  const emitterRedis = new Redis(url, { maxRetriesPerRequest: null });
  const pushConn = new Redis(url, { maxRetriesPerRequest: null });
  const pushNotifier = createPushNotifier(pushConn);
  const baseScheduler = createDispatchScheduler(bullConnection, { reminderFirstMs: timing.reminderFirstMs });
  const scheduler = opts.wrapScheduler ? opts.wrapScheduler(baseScheduler) : baseScheduler;

  const { timing: _t, wrapScheduler: _w, nearby: _n, nearbyEveryMs: _ne, extraWorkerTiming: _e, workers: _wk, workerExtras: _we, ...appOpts } = opts;
  const t = await startTestApp({ redisAdapter: true, ...appOpts, scheduler, appExtras: { pushNotifier, ...appOpts.appExtras } });

  let workers: RideWorkers | undefined;
  try {
    if (opts.workers !== false) workers = await startRideWorkers({
      pool: t.pool,
      redis: workerRedis,
      bullConnection: workerBull,
      emitter: createWorkerEmitter(emitterRedis),
      log: pino({ level: 'silent' }),
      subscriber,
      nearby: opts.nearby ?? false,
      timing: {
        waveDelaysMs: timing.waveDelaysMs,
        continuousScanMs: timing.continuousScanMs,
        reminderEveryMs: timing.reminderEveryMs,
        nearbyEveryMs: opts.nearbyEveryMs ?? 10_000,
        locationFreshMs: timing.locationFreshMs,
        ...opts.extraWorkerTiming,
      },
      ...opts.workerExtras,
    } as Parameters<typeof startRideWorkers>[0]);
  } catch (err) {
    await t.close();
    throw err;
  }

  const close = t.close;
  return Object.assign(t, {
    timing,
    async close() {
      await workers?.close();
      await baseScheduler.close();
      await close();
      await pushNotifier.close().catch(() => undefined);
      await Promise.allSettled([pushConn, bullConnection, workerBull, workerRedis, subscriber, emitterRedis].map((r) => r.quit()));
    },
  });
}
