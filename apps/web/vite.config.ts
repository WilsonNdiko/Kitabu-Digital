import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev server: binds 0.0.0.0 (preview/proxy friendly), accepts any host header,
 * and proxies /api to the local Kitabu API (apps/local-api) — the browser never
 * talks to anything but this origin.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: true,
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
