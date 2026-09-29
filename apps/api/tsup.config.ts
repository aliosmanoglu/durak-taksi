import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  // Workspace paketi TS kaynağı olarak yayınlanır; çıktıya gömülmesi gerekir.
  noExternal: ['@duraknet/shared'],
});
