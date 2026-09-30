import { defineConfig } from 'vitest/config';

// Yalnızca saf mantık (src/lib) test edilir; React Native / Expo modülleri burada yüklenmez.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
