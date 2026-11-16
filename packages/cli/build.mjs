import { build } from 'esbuild';
await build({
  entryPoints: ['src/axo.ts'],
  outfile: 'dist/axo.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
});
console.log('built dist/axo.mjs');
