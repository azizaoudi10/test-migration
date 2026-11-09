import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    // must match DEV_SERVER_URL in electron/main.ts: a bare `localhost`
    // resolves to ::1 first on Windows (Node 17+), so Electron polling
    // 127.0.0.1 would never reach the dev server
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: {
      // build outputs live under the Vite root: watching them reloads the
      // page on every packaging step, and on Windows the watcher's handles
      // block electron-builder's rename of release/win-unpacked.tmp (EPERM)
      // and crash the dev server with EBUSY
      ignored: ['**/release/**', '**/dist-electron/**', '**/dist-renderer/**', '**/coverage/**'],
    },
  },
});
