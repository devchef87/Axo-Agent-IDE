import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
// The axo CLI is embedded so the single-file node can install it into ~/.axo/bin (build cli first).
const cli = readFileSync(new URL('../cli/dist/axo.mjs', import.meta.url), 'utf8');

// Build id: content hash of everything that goes into the bundle. The app
// compares it with a running node's /api/version to detect stale nodes
// (package version alone stays 0.1.0 across rebuilds).
function hashTree(h, dir) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) hashTree(h, p);
    else if (e.name.endsWith('.ts')) h.update(p.slice(p.indexOf('src'))).update(readFileSync(p));
  }
}
const h = createHash('sha256').update(pkg.version);
hashTree(h, new URL('./src', import.meta.url).pathname);
hashTree(h, new URL('../protocol/src', import.meta.url).pathname);
const buildId = h.digest('hex').slice(0, 12);

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/axo-node.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['bufferutil', 'utf-8-validate'],
  define: { __AXO_VERSION__: JSON.stringify(pkg.version), __AXO_BUILD__: JSON.stringify(buildId), __AXO_CLI__: JSON.stringify(cli) },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
writeFileSync(new URL('./dist/axo-node.json', import.meta.url), JSON.stringify({ version: pkg.version, build: buildId }) + '\n');
console.log(`built dist/axo-node.mjs (build ${buildId})`);
