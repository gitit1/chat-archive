import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Ports come from the global dev-ports registry (~/.claude/skills/dev-ports):
// chat-archive API = 5200, viewer dev = 5201. 5173/5174 are banned (Vite defaults).
// Change the target with API_PORT if you started the server on another port.
const API_PORT = process.env.API_PORT ?? 5200;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5201,
    strictPort: true,
    proxy: {
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
