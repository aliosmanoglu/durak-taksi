// Worker süreci. Faz 2: heartbeat sweeper (CLAUDE.md Bölüm 5, Senaryo 3).
// Faz 3'te dispatch dalgaları ve `ride_still_open` hatırlatmaları da buraya eklenecek.
// Zamanlama BullMQ job scheduler'ındadır: birden fazla worker replikası çalışsa da her tikte tek job üretilir.
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { loadWorkerConfig } from './config';
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
  await queue.close().catch((err: Error) => log.warn({ err: err.message }, 'kuyruk kapatılamadı'));
  await Promise.allSettled([redis.quit(), bullConnection.quit()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start().catch((err: unknown) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, 'worker başlatılamadı');
  process.exit(1);
});
