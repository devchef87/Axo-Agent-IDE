import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
// The axo CLI is embedded so the single-file node can install it into ~/.axo/bin (build cli first).
const cli = readFileSync(new URL('../cli/dist/axo.mjs', import.meta.url), 'utf8');
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/axo-node.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['bufferutil', 'utf-8-validate'],
  define: { __AXO_VERSION__: JSON.stringify(pkg.version), __AXO_CLI__: JSON.stringify(cli) },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('built dist/axo-node.mjs');
