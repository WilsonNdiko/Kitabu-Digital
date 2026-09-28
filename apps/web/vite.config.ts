import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// WEB_PORT / KITABU_API let a second "device" run side by side in development
// (e.g. the caretaker-phone demo instance on 5174 → API 4001).
const port = Number(process.env.WEB_PORT || 5173);
const api = process.env.KITABU_API || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port,
    allowedHosts: true,
    proxy: {
      '/api': api,
    },
  },
});
