// Graceful shutdown testleri için ince sarmalayıcı: src/lifecycle.ts (createGracefulShutdown) TestApp.shutdown üzerinden.
import { startRideApp, type RideApp } from './ride-app';

export type ShutdownNode = RideApp;

/** Kapatılacak API node'u (worker'sız; dispatch gerekmez). */
export const startShutdownNode = () => startRideApp({ workers: false });

/** Çıkış kodu: 0 = temiz kapanış, 1 = zaman aşımıyla zorla. */
export const shutdownNode = (n: RideApp, opts: { drainMs: number; timeoutMs: number }) => n.shutdown(opts);
