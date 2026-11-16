import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope } from '@axo/protocol';
import { FileWatcher, isIgnored } from '../src/files/watcher.ts';
import { makeNode, type TestNode } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}

describe('isIgnored', () => {
  it('skips vcs, deps and build output', () => {
    assert.equal(isIgnored('node_modules/x/y.js'), true);
    assert.equal(isIgnored('.git/HEAD'), true);
    assert.equal(isIgnored('src/dist/a.js'), true);
    assert.equal(isIgnored('src/distance.ts'), false);
  });
});

for (const recursive of [true, false]) {
  describe(`FileWatcher (${recursive ? 'native recursive' : 'per-directory'})`, () => {
    let fw: FileWatcher;
    afterEach(() => fw?.close());

    it('reports changes in nested and newly created folders, ignoring node_modules', async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'axo-watch-')));
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'node_modules'));
      const seen: string[] = [];
      fw = new FileWatcher((r, projectId, paths) => { assert.equal(r, root); assert.equal(projectId, 'p1'); seen.push(...paths); }, { recursive });
      const lease = await fw.lease(root, 'p1');
      assert.equal(lease.watching, true);
      await sleep(100); // FSEvents needs a moment to arm

      writeFileSync(join(root, 'src', 'a.ts'), '1');
      await until(() => seen.includes('src/a.ts'));

      mkdirSync(join(root, 'src', 'new'));
      await sleep(150);
      writeFileSync(join(root, 'src', 'new', 'b.ts'), '2');
      await until(() => seen.includes('src/new/b.ts'));

      writeFileSync(join(root, 'node_modules', 'x.js'), '3');
      await sleep(400);
      assert.ok(!seen.some((p) => p.startsWith('node_modules')));
    });

    it('stops when the lease expires or the project is dropped', async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'axo-watch-')));
      fw = new FileWatcher(() => {}, { recursive });
      await fw.lease(root, 'p1', 1000);
      fw.expire(1000 + 5 * 60_000 + 1);
      assert.deepEqual(fw.watched(), []);
      await fw.lease(root, 'p1');
      fw.dropProject('p1');
      assert.deepEqual(fw.watched(), []);
    });
  });
}

describe('files watch api', () => {
  let t: TestNode;
  afterEach(async () => { await t?.stop(); });

  it('leases a watch and publishes files:changed for external edits', async () => {
    t = await makeNode();
    const auth = { Authorization: `Bearer ${t.node.cfg.token}`, 'Content-Type': 'application/json' };
    const base = `http://127.0.0.1:${t.node.cfg.port}/api`;
    const p = await (await fetch(`${base}/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ path: t.project }) })).json() as any;
    const lease = await (await fetch(`${base}/projects/${p.id}/files/watch`, { method: 'POST', headers: auth })).json() as any;
    assert.equal(lease.watching, true);
    await sleep(100);
    writeFileSync(join(t.project, 'edited-by-agent.txt'), 'x'); // not through the API
    await until(() => t.events.some((e: EventEnvelope) => e.type === 'files:changed' && e.projectId === p.id && e.paths.includes('edited-by-agent.txt')));
  });
});
