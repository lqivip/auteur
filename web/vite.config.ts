import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In production the Node service serves web/dist itself; the dev server
// proxies API and media calls to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4377',
      '/media': 'http://127.0.0.1:4377',
    },
  },
});
