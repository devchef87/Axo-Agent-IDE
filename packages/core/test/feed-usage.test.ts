import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resultImages } from '../src/runtime/parser.ts';
import { ImageStore } from '../src/runtime/images.ts';
import { makeNode, type TestNode } from './helpers.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('tool-result images', () => {
  it('extracts base64 image blocks of allowed types, at most 4', () => {
    const block = (t: string) => ({ type: 'image', source: { type: 'base64', media_type: t, data: PNG } });
    assert.deepEqual(resultImages('text only'), []);
    assert.equal(resultImages([block('image/png'), { type: 'text', text: 'x' }, block('image/svg+xml')]).length, 1);
    assert.equal(resultImages(Array.from({ length: 6 }, () => block('image/png'))).length, 4);
  });

  it('stores content-addressed files, validates ids, prunes the oldest', () => {
    const home = mkdtempSync(join(tmpdir(), 'axo-img-'));
    const s = new ImageStore(home);
    const [a] = s.save('agent1', [{ mediaType: 'image/png', data: PNG }]);
    assert.match(a.id, /^[a-f0-9]{24}\.png$/);
    assert.deepEqual(s.save('agent1', [{ mediaType: 'image/png', data: PNG }])[0].id, a.id, 'same bytes, same id');
    assert.equal(s.path('agent1', '../../etc/passwd'), null);
    assert.equal(s.path('../x', a.id), null);
    // Fill past the cap with distinct images; the oldest goes.
    const dir = join(home, 'agents', 'agent1', 'images');
    utimesSync(join(dir, a.id), 1, 1);
    for (let i = 0; i < 100; i++) s.save('agent1', [{ mediaType: 'image/png', data: Buffer.from(`img${i}`).toString('base64') }]);
    const files = readdirSync(dir);
    assert.equal(files.length, 100);
    assert.ok(!files.includes(a.id));
    s.remove('agent1');
    assert.throws(() => readdirSync(dir));
  });
});

describe('feed images + usage api', () => {
  let t: TestNode;
  afterEach(async () => { await t?.stop(); });

  it('attaches stored images to the tool item, serves them, and totals usage since a time', async () => {
    t = await makeNode();
    const auth = { Authorization: `Bearer ${t.node.cfg.token}`, 'Content-Type': 'application/json' };
    const base = `http://127.0.0.1:${t.node.cfg.port}/api`;
    const before = Date.now() - 1;
    const p = await (await fetch(`${base}/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ path: t.project }) })).json() as any;
    const a = await (await fetch(`${base}/agents`, { method: 'POST', headers: auth, body: JSON.stringify({ projectId: p.id, name: 'img', task: 'IMAGE please' }) })).json() as any;
    const tool = await t.waitFor(() => t.feed(a.id).find((i: any) => i.kind === 'tool' && i.images?.length) as any);
    assert.equal(tool.images[0].mediaType, 'image/png');
    const img = await fetch(`${base}/agents/${a.id}/images/${tool.images[0].id}?token=${t.node.cfg.token}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await img.arrayBuffer()).toString('base64'), PNG);
    assert.equal((await fetch(`${base}/agents/${a.id}/images/nope.png?token=${t.node.cfg.token}`)).status, 404);

    await t.waitFor(() => t.feed(a.id).some((i: any) => i.kind === 'turn'));
    const u = await (await fetch(`${base}/usage?since=${before}`, { headers: auth })).json() as any;
    assert.equal(u.agents[a.id].turns, 1);
    assert.equal(u.total.turns, 1);
    assert.ok(u.total.cacheRead > 0);
    const later = await (await fetch(`${base}/usage?since=${Date.now() + 60_000}`, { headers: auth })).json() as any;
    assert.equal(later.total.turns, 0);
  });
});
