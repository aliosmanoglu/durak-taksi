// Worker süreci. Faz 2: heartbeat sweeper (CLAUDE.md Bölüm 5, Senaryo 3).
// Faz 3: dispatch dalgaları + sürekli tarama, `ride_still_open` hatırlatması, `stand_nearby_drivers` (rides/).
// Zamanlama BullMQ job scheduler'ındadır: birden fazla worker replikası çalışsa da her tikte tek job üretilir.
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import pino from 'pino';
import { loadWorkerConfig } from './config';
import { DEFAULT_TIMING } from './rides/dispatch';
import { createWorkerEmitter } from './rides/emitter';
import { startRideWorkers, type RideWorkers } from './rides/workers';
import { sweepStaleDrivers } from './sweeper';

const config = loadWorkerConfig();
const log = pino({ level: config.LOG_LEVEL });

const PRESENCE_QUEUE = 'presence';
const SWEEP_SCHEDULER_ID = 'presence-sweep';

// Uygulama komutları (sweeper Lua) için normal bağlantı.
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
redis.on('error', (err) => log.warn({ err: err.message }, 'redis hatası'));
// BullMQ bloklayan komutlar kullanır ve maxRetriesPerRequest: null ister.
const bullConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
bullConnection.on('error', (err) => log.warn({ err: err.message }, 'bullmq redis hatası'));

const queue = new Queue(PRESENCE_QUEUE, { connection: bullConnection });

// Faz 3: dispatch için PG (ride/durak verisi) ve odalara yayın için redis-emitter; abonelik ayrı bağlantıdadır.
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
pool.on('error', (err) => log.warn({ err: err.message }, 'pg havuz hatası'));
const subscriber = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
subscriber.on('error', (err) => log.warn({ err: err.message }, 'abone redis hatası'));
let rideWorkers: RideWorkers | undefined;

// Job idempotenttir: her çalışmada Redis'teki güncel heartbeat'e bakar; tekrar çalışması zararsızdır.
const worker = new Worker(
  PRESENCE_QUEUE,
  async () => {
    const removed = await sweepStaleDrivers(redis, { staleMs: config.HEARTBEAT_STALE_MS });
    // Gizlilik: driverId ve konum loglanmaz, yalnızca sayı.
    if (removed.length > 0) log.info({ count: removed.length }, 'eski şoförler offline yapıldı');
    else log.debug('sweep: eski şoför yok');
    return { count: removed.length };
  },
  { connection: bullConnection, concurrency: 1 },
);
worker.on('failed', (_job, err) => log.warn({ err: err.message }, 'sweep job başarısız'));
worker.on('error', (err) => log.warn({ err: err.message }, 'bullmq worker hatası'));

async function start() {
  await queue.upsertJobScheduler(
    SWEEP_SCHEDULER_ID,
    { every: config.SWEEP_EVERY_MS },
    { name: 'sweep', opts: { removeOnComplete: true, removeOnFail: 100 } },
  );
  rideWorkers = await startRideWorkers({
    pool, redis, bullConnection, subscriber, log,
    emitter: createWorkerEmitter(redis),
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
  log.info(
    { staleMs: config.HEARTBEAT_STALE_MS, everyMs: config.SWEEP_EVERY_MS },
    'worker başladı: heartbeat sweeper planlandı',
  );
}

const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'kapanıyor');
  // Takılan bir kapanış (asılı job, erişilemeyen Redis) süreci sonsuza dek tutmasın.
  setTimeout(() => {
    log.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'kapanış zaman aşımı; zorla çıkılıyor');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  // Önce worker: çalışan job bitirilir, yenisi alınmaz.
  await worker.close().catch((err: Error) => log.warn({ err: err.message }, 'worker kapatılamadı'));
  await rideWorkers?.close().catch((err: Error) => log.warn({ err: err.message }, 'ride worker kapatılamadı'));
  await queue.close().catch((err: Error) => log.warn({ err: err.message }, 'kuyruk kapatılamadı'));
  await Promise.allSettled([redis.quit(), bullConnection.quit(), subscriber.quit(), pool.end()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start().catch((err: unknown) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, 'worker başlatılamadı');
  process.exit(1);
});
