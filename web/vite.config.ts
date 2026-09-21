import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  worker: {
    format: 'es',
  },
  build: {
    // Keep the previous deploys' hashed bundles in dist/assets. A tab that
    // still holds a pre-deploy index.html must be able to load the bundles
    // it names; scripts/prune-web-assets.mjs drops old ones after the build.
    emptyOutDir: false,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3100',
      '/ws': { target: 'ws://127.0.0.1:3100', ws: true },
    },
  },
});
