import { defineConfig } from 'vite';

// Relative base so the build works at https://<user>.github.io/<repo>/ without
// hard-coding the repository name.
export default defineConfig({
  base: './',
  // MapLibre alone is ~1 MB minified.
  build: { chunkSizeWarningLimit: 1500 },
});
