// Train Track Builder: a second page built from the same source (builder/index.html).
// `npm run dev:builder` serves it on port 5184; `npm run build:builder` writes dist-builder/.
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'builder',
  build: { outDir: '../dist-builder', emptyOutDir: true },
  server: { port: 5184, strictPort: true, fs: { allow: ['..'] } },
});
