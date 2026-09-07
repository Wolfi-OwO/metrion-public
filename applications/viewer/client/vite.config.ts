import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    /**
     * Measured, not guessed: the bundle is 566 kB raw / 169 kB gzipped, and
     * roughly 120 kB of the gzipped total is recharts. Vite's default 500 kB
     * warning would fire on every build, and a warning that always fires is a
     * warning nobody reads - so the limit is moved once, deliberately, rather
     * than the message being ignored.
     *
     * ponytail: accepted, not solved. Express serves this bundle from the same
     * scale-to-zero container as the API, so it is fetched during the same
     * 5-15s cold start it is competing with - a second of transfer against
     * fifteen of container start, and cached from then on. Upgrade path if it
     * ever matters: drop recharts for hand-drawn SVG polylines, which is what
     * these strip charts actually are, before reaching for code splitting -
     * splitting moves the bytes, it does not remove them.
     */
    chunkSizeWarningLimit: 700,
    // Task 13 serves this directory from the Express app itself, so the output
    // stays inside the client workspace rather than being written up into the
    // server's tree - one build, one owner of the folder it writes.
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    // Same-origin in dev, exactly as it will be in production once Express
    // serves `dist/`. No CORS config to keep in sync, and no base URL: every
    // request in `src/api/client.ts` is a bare `/api/...` path.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
});
