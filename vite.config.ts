import { defineConfig } from 'vite';

// Relative base so the build works at https://<user>.github.io/<repo>/ without
// hard-coding the repository name.
export default defineConfig({
  base: './',
  // MapLibre alone is ~1 MB minified.
  build: { chunkSizeWarningLimit: 1500 },
  // `npm run dev:worker` runs the upload API on 8787; `npm run dev` passes /api/ to it.
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
