// Worker süreci girişi: yapılandırma + sinyaller. Asıl kurulum start.ts'tedir (bkz. orası).
import pino from 'pino';
import { loadWorkerConfig } from './config';
import { startWorker, type RunningWorker } from './start';

const config = loadWorkerConfig();
const log = pino({ level: config.LOG_LEVEL });

const SHUTDOWN_TIMEOUT_MS = 10_000;
let starting: Promise<RunningWorker | undefined> = Promise.resolve(undefined);
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) {
    log.warn({ signal }, 'ikinci kapanış sinyali; zorla çıkılıyor');
    process.exit(1);
  }
  shuttingDown = true;
  log.info({ signal }, 'kapanıyor');
  // Takılan bir kapanış (asılı job, erişilemeyen Redis) süreci sonsuza dek tutmasın.
  setTimeout(() => {
    log.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'kapanış zaman aşımı; zorla çıkılıyor');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  // Sinyal başlatma bitmeden geldiyse önce başlatmanın bitmesi beklenir, sonra temiz kapatılır (yarım kalan kaynak yok).
  const running = await starting;
  await running?.close().catch((err: Error) => log.warn({ err: err.message }, 'worker kapatılamadı'));
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

starting = startWorker({ config, log }).catch((err: unknown) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, 'worker başlatılamadı');
  process.exit(1);
});
