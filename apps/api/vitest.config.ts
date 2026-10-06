import { defineConfig } from 'vitest/config';

// İki proje: birim testleri Docker gerektirmez; entegrasyon testleri (*.integration.test.ts)
// globalSetup ile tek bir PostGIS + Redis konteyner çiftini paylaşır (çalıştırma başına bir kez başlar).
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/**/*.integration.test.ts'],
          globalSetup: ['test/helpers/containers.ts'],
          // İlk imaj çekişi dakikalar sürebilir (globalSetup hookTimeout'a tabi değildir ama beforeAll'lar DB'ye bağlanır).
          hookTimeout: 180_000,
          // argon2 (19 MiB, t=2) test başına birkaç hash/verify yapar.
          testTimeout: 30_000,
          // Uzlaştırıcı (ride-reconcile) paylaşılan Redis'in tamamını tarar; dosyalar paralel koşarsa başka dosyanın
          // bilerek bozulmuş state'ini onarıp testleri kırar (presence-sync, ride-session). Bu yüzden seri.
          fileParallelism: false,
        },
      },
    ],
  },
});
