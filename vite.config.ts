import { defineConfig } from 'vite';

// Relative base so the build works at the custom domain's root
// (https://openfieldview.org/) and at https://<user>.github.io/<repo>/ on forks,
// without hard-coding either.
export default defineConfig({
  base: './',
  // MapLibre alone is ~1 MB minified.
  build: { chunkSizeWarningLimit: 1500 },
});
