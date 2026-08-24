import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Builds the dashboard only. The Worker is built by wrangler from `src/worker/index.ts` and never
 * reaches this output, which is why `dist/client` is a directory of its own: `.size-limit.json`
 * points at it, and so does the client-secret gate in CI. Pointed at `dist` instead, both would be
 * measuring and scanning server code.
 */
/** Everything the Worker owns. `wrangler dev` serves these while `vite` serves the screens. */
const WORKER_PATHS = ["/api", "/intake", "/webhooks", "/health"];

export default defineConfig({
  root: "src/ui",
  plugins: [react()],
  server: {
    // Loopback only, never every interface: this proxies to a build that can place telephone calls.
    host: "127.0.0.1",
    proxy: Object.fromEntries(
      WORKER_PATHS.map((path) => [path, "http://127.0.0.1:8787"]),
    ),
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    sourcemap: false,
    // Nothing is inlined as a data URI. An inlined font is bytes the browser cannot cache
    // separately, and it also turns a file the client-secret gate would read into a base64 blob
    // inside a stylesheet, which is the shape that gate has to decode its way back out of.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // No content hashes. `scripts/vendor/a11y-prove.mjs` reintroduces a real defect into a
        // named built file and expects the gate to catch it, and `.size-limit.json` measures a
        // named file: both need a path that is the same after every build. Cloudflare serves these
        // with an ETag either way, so the caching a hash buys is not lost.
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
