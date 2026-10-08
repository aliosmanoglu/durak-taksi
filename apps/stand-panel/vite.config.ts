import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  test: {
    // Yalnızca saf mantık (src/lib) test edilir; DOM/React katmanı testsizdir (typecheck + build).
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
