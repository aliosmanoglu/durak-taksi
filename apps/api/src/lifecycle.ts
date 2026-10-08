// API graceful shutdown (Faz 5, docs/design/faz5-resilience.md Bölüm 5). server.ts bunu kullanır; mantık burada
// ayrıdır ki entegrasyon testleri `process.exit` olmadan çalıştırabilsin.
// Sıra: bayrak (/ready 503) → drain bekleme (LB node'u çıkarsın) → httpServer.close (yeni bağlantı yok) →
// io.close (istemciler kopar ve diğer node'a bağlanıp session_sync ile devam eder) → kaynakları kapat → çık.
// Zaman aşımında zorla çıkılır (worker'daki desenle paralel).
import type { Server as HttpServer } from 'node:http';
import type { Logger } from 'pino';

export type GracefulShutdownDeps = {
  log: Logger;
  /** /ready 503 verdikten sonra LB'nin node'u çıkarması için bekleme (ms). */
  drainMs: number;
  /** Bu süreyi aşan kapanış zorla sonlandırılır (ms). */
  timeoutMs: number;
  httpServer: HttpServer;
  io: { close(fn?: (err?: Error) => void): unknown };
  /** Scheduler, notifier, DB ve Redis bağlantılarını kapatır. */
  closeResources: () => Promise<void>;
  /** Varsayılan `process.exit`; testler verir. */
  exit?: (code: number) => void;
};

export type GracefulShutdown = {
  shutdown(signal: string): Promise<void>;
  /** `/ready` için: kapanış başladıysa true. */
  isShuttingDown(): boolean;
};

export function createGracefulShutdown(deps: GracefulShutdownDeps): GracefulShutdown {
  const { log, httpServer } = deps;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) {
      // İkinci sinyal (operatör sabırsızlandı): zorla çık.
      log.warn({ signal }, 'ikinci kapanış sinyali; zorla çıkılıyor');
      exit(1);
      return;
    }
    shuttingDown = true;
    log.info({ signal, drainMs: deps.drainMs }, 'kapanıyor');
    const timer = setTimeout(() => {
      log.error({ timeoutMs: deps.timeoutMs }, 'kapanış zaman aşımı; zorla çıkılıyor');
      exit(1);
    }, deps.timeoutMs);
    timer.unref();

    await new Promise<void>((r) => setTimeout(r, deps.drainMs));
    // Yeni bağlantı kabul edilmez. Callback, açık socket'ler bitince çalışır; io.close onları keser.
    const httpClosed = new Promise<void>((r) => httpServer.close(() => r()));
    httpServer.closeIdleConnections();
    await new Promise<void>((r) => void deps.io.close(() => r()));
    await httpClosed;
    await deps.closeResources().catch((err: unknown) =>
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'kaynaklar kapatılırken hata'),
    );
    clearTimeout(timer);
    exit(0);
  }

  return { shutdown, isShuttingDown: () => shuttingDown };
}
