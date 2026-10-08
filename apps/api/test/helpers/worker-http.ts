// Gerçek worker'ı (apps/worker/src/start.ts → startWorker) süreç içinde, testin PG + Redis'ine bağlı başlatır.
// Sweeper tikleri seyrektir (SWEEP_EVERY_MS büyük): testler /ready tazeliğini `dn:worker:sweeper:last_tick` ile yönetir.
import { inject } from 'vitest';
import pino from 'pino';
import { loadWorkerConfig } from '../../../worker/src/config';
import { startWorker } from '../../../worker/src/start';
import type { PushSender } from '../../../worker/src/push/sender';
import type { TestApp } from './app';

export type WorkerHttpHandle = { url: string; close(): Promise<void> };

export async function startWorkerHttpForTest(
  _t: TestApp,
  opts: { metricsToken?: string; pushSender?: PushSender } = {},
): Promise<WorkerHttpHandle> {
  const config = loadWorkerConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    REDIS_URL: inject('redisUrl'),
    DATABASE_URL: inject('pgUrl'),
    WORKER_HTTP_PORT: '0',
    SWEEP_EVERY_MS: '3600000', // tazelik eşiği = 3 tik (3 saat): bayat testi için 6 saat öncesi kullanılır
    RECONCILE_EVERY_S: '3600',
    PUSH_ENABLED: opts.pushSender ? 'true' : 'false',
    ...(opts.metricsToken ? { METRICS_TOKEN: opts.metricsToken } : {}),
  });
  const w = await startWorker({ config, log: pino({ level: 'silent' }), ...(opts.pushSender ? { pushSender: opts.pushSender } : {}) });
  return { url: `http://127.0.0.1:${w.httpPort}`, close: () => w.close() };
}
