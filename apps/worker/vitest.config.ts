import { defineConfig } from 'vitest/config';

// Worker testleri gerçek Redis'e karşı koşar (testcontainers, çalıştırma başına tek konteyner).
// Sweeper Redis'in tamamını taradığından testler birbirini etkileyebilir: dosyalar da sıralı koşar
// (dosya içindeki testler zaten sıralıdır).
export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/helpers/redis-container.ts'],
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
