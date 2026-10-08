// Worker başlatıcısı. index.ts yalnızca sinyalleri bağlar; mantık burada ki testler gerçek bağımlılıklarla ve
// enjekte edilmiş `PushSender` ile worker'ı süreç içinde başlatabilsin.
// Faz 2: heartbeat sweeper (CLAUDE.md Bölüm 5, Senaryo 3). Faz 3: dispatch dalgaları, hatırlatma, yakındaki araçlar,
// uzlaştırıcı (rides/). Faz 5: push, health/ready/metrics HTTP.
// Zamanlama BullMQ job scheduler'ındadır: birden fazla worker replikası çalışsa da her tikte tek job üretilir.
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import type { Logger } from 'pino';
import { redisKeys } from '@duraknet/shared';
import type { WorkerConfig } from './config';
import { startWorkerHttp, type ReadinessResult, type WorkerHttp } from './http';
import { workerMetrics } from './metrics';
import { ExpoPushSender, type PushSender } from './push/sender';
import { DEFAULT_TIMING } from './rides/dispatch';
import { createWorkerEmitter } from './rides/emitter';
import { startRideWorkers, type RideWorkers } from './rides/workers';
import { sweepStaleDrivers } from './sweeper';

const PRESENCE_QUEUE = 'presence';
const SWEEP_SCHEDULER_ID = 'presence-sweep';

export type StartWorkerOptions = {
  config: WorkerConfig;
  log: Logger;
  /**
   * Push göndericisi. Verilmezse (ve `PUSH_ENABLED` ise) `ExpoPushSender` kullanılır; testler sahte verir.
   * `PUSH_ENABLED=false` iken verilse bile push kapalıdır.
   */
  pushSender?: PushSender;
};

export type RunningWorker = {
  /** Worker HTTP sunucusunun gerçek portu (`WORKER_HTTP_PORT=0` ise rastgele). */
  httpPort: number;
  /** Kapanış bayrağını kaldırır (`/ready` 503) ve her şeyi kapatır. */
  close(): Promise<void>;
};

export async function startWorker(opts: StartWorkerOptions): Promise<RunningWorker> {
  const { config, log } = opts;
  const metrics = workerMetrics();
  const startedAt = Date.now();
  let shuttingDown = false;

  // Uygulama komutları (sweeper Lua) için normal bağlantı.
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on('error', (err) => log.warn({ err: err.message }, 'redis hatası'));
  // BullMQ bloklayan komutlar kullanır ve maxRetriesPerRequest: null ister.
  const bullConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  bullConnection.on('error', (err) => log.warn({ err: err.message }, 'bullmq redis hatası'));
  const subscriber = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  subscriber.on('error', (err) => log.warn({ err: err.message }, 'abone redis hatası'));
  // Faz 3: dispatch için PG (ride/durak verisi) ve odalara yayın için redis-emitter.
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  pool.on('error', (err) => log.warn({ err: err.message }, 'pg havuz hatası'));
  metrics.bind({ redis, pool });

  const queue = new Queue(PRESENCE_QUEUE, { connection: bullConnection });

  // Job idempotenttir: her çalışmada Redis'teki güncel heartbeat'e bakar; tekrar çalışması zararsızdır.
  const worker = new Worker(
    PRESENCE_QUEUE,
    async () => {
      const removed = await sweepStaleDrivers(redis, { staleMs: config.HEARTBEAT_STALE_MS });
      // /ready tazeliği: son tik zamanı Redis'te (çok replikada tikleri hangi replika çalıştırırsa çalıştırsın görülür).
      await redis.set(redisKeys.sweeperLastTick, String(Date.now())).catch((err: Error) =>
        log.warn({ err: err.message }, 'sweeper tik zamanı yazılamadı'),
      );
      // Gizlilik: driverId ve konum loglanmaz, yalnızca sayı.
      if (removed.length > 0) log.info({ count: removed.length }, 'eski şoförler offline yapıldı');
      else log.debug('sweep: eski şoför yok');
      return { count: removed.length };
    },
    { connection: bullConnection, concurrency: 1 },
  );
  worker.on('failed', (_job, err) => log.warn({ err: err.message }, 'sweep job başarısız'));
  worker.on('error', (err) => log.warn({ err: err.message }, 'bullmq worker hatası'));

  // Sweeper en geç bu süredir tik atmadıysa worker "hazır değil" sayılır (açılıştaki ilk tik için de aynı süre tanınır).
  const sweepFreshMs = Math.max(config.SWEEP_EVERY_MS * 3, 30_000);
  async function readiness(): Promise<ReadinessResult> {
    const checks: Record<string, 'ok' | 'fail'> = {};
    const run = async (name: string, fn: () => Promise<boolean | void>) => {
      try {
        checks[name] = (await fn()) === false ? 'fail' : 'ok';
      } catch {
        checks[name] = 'fail';
      }
    };
    await Promise.all([
      run('postgres', async () => void (await pool.query('SELECT 1'))),
      run('redis', async () => void (await redis.ping())),
      run('sweeper', async () => {
        const last = Number(await redis.get(redisKeys.sweeperLastTick));
        const ref = Number.isFinite(last) && last > 0 ? last : startedAt;
        return Date.now() - ref < sweepFreshMs;
      }),
    ]);
    return { ok: Object.values(checks).every((c) => c === 'ok'), checks };
  }

  const http: WorkerHttp = await startWorkerHttp({
    port: config.WORKER_HTTP_PORT,
    registry: metrics.registry,
    readiness,
    isShuttingDown: () => shuttingDown,
    ...(config.METRICS_TOKEN ? { metricsToken: config.METRICS_TOKEN } : {}),
    allowAnon: config.METRICS_ALLOW_ANON,
  });

  const pushSender = config.PUSH_ENABLED
    ? (opts.pushSender ?? new ExpoPushSender(config.EXPO_ACCESS_TOKEN ? { accessToken: config.EXPO_ACCESS_TOKEN } : {}))
    : undefined;

  if (!pushSender) {
    log.warn("PUSH_ENABLED=false: push gönderilmez ve 'push' kuyruğu işlenmez. API'de PUSH_ENABLED=true ise account_suspended job'ları kuyrukta birikir; iki tarafı aynı tutun");
  }

  let rideWorkers: RideWorkers | undefined;
  try {
    await queue.upsertJobScheduler(
      SWEEP_SCHEDULER_ID,
      { every: config.SWEEP_EVERY_MS },
      { name: 'sweep', opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    rideWorkers = await startRideWorkers({
      pool, redis, bullConnection, subscriber, log, metrics,
      emitter: createWorkerEmitter(redis),
      ...(pushSender ? { push: pushSender } : {}),
      pushTtlS: config.PUSH_TTL_S,
      pushReceiptDelayMs: config.PUSH_RECEIPT_DELAY_S * 1000,
      timing: {
        ...DEFAULT_TIMING,
        waveDelaysMs: config.DISPATCH_WAVE_DELAYS_S,
        continuousScanMs: config.DISPATCH_SCAN_EVERY_S * 1000,
        reminderEveryMs: config.REMINDER_EVERY_SEC * 1000,
        nearbyEveryMs: config.NEARBY_EVERY_S * 1000,
        locationFreshMs: config.LOCATION_FRESH_MS,
        reminderFirstMs: config.REMINDER_FIRST_SEC * 1000,
        reconcileEveryMs: config.RECONCILE_EVERY_S * 1000,
        reconcileMinAgeMs: config.RECONCILE_MIN_AGE_S * 1000,
        reconcileOrphanAgeMs: config.RECONCILE_ORPHAN_AGE_S * 1000,
      },
    });
  } catch (err) {
    await http.close();
    throw err;
  }
  log.info(
    { staleMs: config.HEARTBEAT_STALE_MS, everyMs: config.SWEEP_EVERY_MS, httpPort: http.port, push: Boolean(pushSender) },
    'worker başladı: heartbeat sweeper planlandı',
  );

  return {
    httpPort: http.port,
    async close() {
      shuttingDown = true; // /ready 503
      // Önce işçiler: çalışan job bitirilir, yenisi alınmaz.
      await worker.close().catch((err: Error) => log.warn({ err: err.message }, 'worker kapatılamadı'));
      await rideWorkers?.close().catch((err: Error) => log.warn({ err: err.message }, 'ride worker kapatılamadı'));
      await queue.close().catch((err: Error) => log.warn({ err: err.message }, 'kuyruk kapatılamadı'));
      await http.close();
      await Promise.allSettled([redis.quit(), bullConnection.quit(), subscriber.quit(), pool.end()]);
    },
  };
}
