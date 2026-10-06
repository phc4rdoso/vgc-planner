import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    // The calculator ships all generations' data (a few MB). It is loaded lazily, so a large chunk is expected.
    chunkSizeWarningLimit: 6000,
  },
  // /api goes to the Worker (`npm run dev:api`), so the app and the API share one origin, as in production.
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8787' } },
  preview: { port: 4173 },
});
