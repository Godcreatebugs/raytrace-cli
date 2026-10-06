import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const proxy = `http://127.0.0.1:${process.env.RAYTACE_PORT || 8797}`;

// `npm run build` writes the static dashboard into dist/dashboard, which the
// proxy serves. `npm run dashboard:dev` serves it with hot reload and forwards
// API calls to a running proxy.
export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': here } },
  build: { chunkSizeWarningLimit: 1000, outDir: fileURLToPath(new URL('../dist/dashboard', import.meta.url)), emptyOutDir: true },
  server: { proxy: { '/raytace': proxy } },
});
