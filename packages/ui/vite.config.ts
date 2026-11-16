import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    react(),
    tailwind(),
    // Vite's dev server injects inline scripts (HMR preamble); allow them in dev only.
    { name: 'dev-csp', apply: 'serve', transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") },
  ],
  base: './',
  server: { port: 5199, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
