// Ride worker'larını kurar: dispatch, reminder, stand_nearby_drivers ve `dn:events:ride` dinleyicisi.
// index.ts ve (aynı süreçte worker çalıştırmak isteyen) entegrasyon testleri bunu kullanır.
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import {
  QUEUES, redisKeys, RIDE_EVENTS_CHANNEL, RIDE_HASH, rideEventMessageSchema,
  type DispatchJobData, type ReminderJobData,
} from '@duraknet/shared';
import type { WorkerEmitter } from './emitter';
import {
  continueDispatchChain, continueReminderChain, processDispatch, processNearby, processReminder,
  type DispatchTiming, type RideJobDeps,
} from './dispatch';
import { processReconcile } from './reconcile';

export type RideWorkersOptions = {
  pool: Pool;
  /** Komutlar için normal bağlantı. */
  redis: Redis;
  /** BullMQ için `maxRetriesPerRequest: null` bağlantı (çağıran kapatır). */
  bullConnection: Redis;
  emitter: WorkerEmitter;
  log: Logger;
  timing: DispatchTiming;
  /** `dn:events:ride` aboneliği için ayrı bağlantı (çağıran kapatır). Verilmezse dinleyici kurulmaz. */
  subscriber?: Redis;
  /** `stand_nearby_drivers` job scheduler'ı kurulsun mu (testler kapatabilir). Varsayılan true. */
  nearby?: boolean;
};

export type RideWorkers = { close(): Promise<void> };

const NEARBY_SCHEDULER_ID = 'stand-nearby';
const RECONCILE_SCHEDULER_ID = 'ride-reconcile';

export async function startRideWorkers(opts: RideWorkersOptions): Promise<RideWorkers> {
  const { redis, bullConnection, log, timing } = opts;
  const dispatchQueue = new Queue<DispatchJobData>(QUEUES.dispatch, { connection: bullConnection });
  const reminderQueue = new Queue<ReminderJobData>(QUEUES.reminder, { connection: bullConnection });
  const nearbyQueue = new Queue(QUEUES.nearby, { connection: bullConnection });
  const reconcileQueue = new Queue(QUEUES.reconcile, { connection: bullConnection });
  const deps: RideJobDeps = {
    pool: opts.pool, redis, emitter: opts.emitter, log, timing, dispatchQueue, reminderQueue,
  };

  const onError = (name: string) => (err: Error) => log.warn({ err: err.message }, `${name} worker hatası`);
  const dispatchWorker = new Worker<DispatchJobData>(QUEUES.dispatch, (job) => processDispatch(deps, job.data), {
    connection: bullConnection, concurrency: 10,
  });
  const reminderWorker = new Worker<ReminderJobData>(QUEUES.reminder, (job) => processReminder(deps, job.data), {
    connection: bullConnection, concurrency: 10,
  });
  const nearbyWorker = new Worker(QUEUES.nearby, () => processNearby(deps), { connection: bullConnection, concurrency: 1 });
  dispatchWorker.on('error', onError('dispatch'));
  reminderWorker.on('error', onError('reminder'));
  nearbyWorker.on('error', onError('nearby'));
  // Son deneme de başarısız olursa zincir kopmasın: ride hâlâ `searching` ise sonraki dalga/hatırlatma planlanır.
  const exhausted = (j: { attemptsMade: number; opts: { attempts?: number } } | undefined) =>
    j !== undefined && j.attemptsMade >= (j.opts.attempts ?? 1);
  dispatchWorker.on('failed', (j, err) => {
    log.warn({ err: err.message }, 'dispatch job başarısız');
    if (j && exhausted(j)) void continueDispatchChain(deps, j.data);
  });
  reminderWorker.on('failed', (j, err) => {
    log.warn({ err: err.message }, 'reminder job başarısız');
    if (j && exhausted(j)) void continueReminderChain(deps, j.data);
  });
  nearbyWorker.on('failed', (_j, err) => log.warn({ err: err.message }, 'nearby job başarısız'));

  if (opts.nearby !== false) {
    await nearbyQueue.upsertJobScheduler(
      NEARBY_SCHEDULER_ID, { every: timing.nearbyEveryMs },
      { name: 'nearby', opts: { removeOnComplete: true, removeOnFail: 50 } },
    );
  }

  // Uzlaştırıcı (yalnızca `reconcileEveryMs` verilirse): job'sız kalmış / sapmış ride ve şoför durumlarını düzeltir.
  let reconcileWorker: Worker | undefined;
  if (timing.reconcileEveryMs) {
    reconcileWorker = new Worker(QUEUES.reconcile, () => processReconcile(deps), { connection: bullConnection, concurrency: 1 });
    reconcileWorker.on('error', onError('reconcile'));
    reconcileWorker.on('failed', (_j, err) => log.warn({ err: err.message }, 'reconcile job başarısız'));
    await reconcileQueue.upsertJobScheduler(
      RECONCILE_SCHEDULER_ID, { every: timing.reconcileEveryMs },
      { name: 'reconcile', opts: { removeOnComplete: true, removeOnFail: 50 } },
    );
  }

  // `dn:events:ride` (Pub/Sub, at-most-once): yalnızca temizlik. Ride `searching`'den çıkınca bekleyen dalga ve
  // hatırlatma job'ları silinir. Kaçırılırsa job'lar kendiliğinden durumu görüp biter (doğruluk buna bağlı değildir).
  const sub = opts.subscriber;
  if (sub) {
    sub.on('message', (_channel, raw) => {
      void (async () => {
        try {
          const ev = rideEventMessageSchema.safeParse(JSON.parse(raw));
          if (!ev.success || ev.data.from !== 'searching' || ev.data.to === 'searching') return;
          const [d, r] = await redis.hmget(redisKeys.ride(ev.data.rideId), RIDE_HASH.dispatchJob, RIDE_HASH.reminderJob);
          if (d) await dispatchQueue.remove(d);
          if (r) await reminderQueue.remove(r);
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : String(err) }, 'ride olayı işlenemedi');
        }
      })();
    });
    await sub.subscribe(RIDE_EVENTS_CHANNEL);
  }

  return {
    async close() {
      if (sub) await sub.unsubscribe(RIDE_EVENTS_CHANNEL).catch(() => undefined);
      await Promise.allSettled([dispatchWorker.close(), reminderWorker.close(), nearbyWorker.close(), reconcileWorker?.close()]);
      await Promise.allSettled([dispatchQueue.close(), reminderQueue.close(), nearbyQueue.close(), reconcileQueue.close()]);
    },
  };
}
