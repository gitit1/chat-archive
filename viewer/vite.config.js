import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API (src/cli/serve.js) runs on 5199 in dev; Vite proxies /api to it.
// Change the target with API_PORT if you started the server on another port.
const API_PORT = process.env.API_PORT ?? 5199;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
