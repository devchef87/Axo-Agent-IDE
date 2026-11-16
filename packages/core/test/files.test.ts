import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope } from '@axo/protocol';
import { confine } from '../src/files/paths.ts';
import { parseDiff } from '../src/files/files.ts';
import { makeNode, type TestNode } from './helpers.ts';

describe('confine', () => {
  const root = mkdtempSync(join(tmpdir(), 'axo-confine-'));
  mkdirSync(join(root, 'src'));
  const outside = mkdtempSync(join(tmpdir(), 'axo-outside-'));
  symlinkSync(outside, join(root, 'escape'));
  symlinkSync(join(root, 'src'), join(root, 'inside-link'));

  it('maps relative paths onto the root', () => {
    assert.equal(confine(root, ''), root);
    assert.equal(confine(root, 'src/a.ts'), join(root, 'src', 'a.ts'));
    assert.equal(confine(root, './src'), join(root, 'src'));
    assert.equal(confine(root, 'inside-link/x'), join(root, 'inside-link', 'x'));
  });

  it('rejects absolute paths, traversal, NUL and escaping symlinks', () => {
    for (const bad of ['/etc/passwd', '../x', 'src/../../x', 'a\0b', 'escape', 'escape/new-file', 'C:/x']) {
      assert.throws(() => confine(root, bad), (e: any) => e.status === 400, bad);
    }
  });
});

describe('parseDiff', () => {
  it('splits files and counts lines', () => {
    const raw = [
      'diff --git a/a.txt b/a.txt', 'index 1..2 100644', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1,2 @@', '-old', '+new', '+more',
      'diff --git a/b.txt b/b.txt', 'new file mode 100644', '--- /dev/null', '+++ b/b.txt', '@@ -0,0 +1 @@', '+hi', '',
    ].join('\n');
    const d = parseDiff(raw);
    assert.equal(d.length, 2);
    assert.deepEqual([d[0].path, d[0].status, d[0].additions, d[0].deletions], ['a.txt', 'modified', 2, 1]);
    assert.deepEqual([d[1].path, d[1].status, d[1].additions], ['b.txt', 'added', 1]);
    assert.ok(d[0].patch.startsWith('diff --git a/a.txt'));
  });
});

let t: TestNode;
afterEach(async () => { await t?.stop(); t = undefined as any; });

const base = () => `http://127.0.0.1:${t.node.cfg.port}/api`;
const call = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(base() + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.node.cfg.token}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() as any };
};
const post = (path: string, body: unknown) => call(path, { method: 'POST', body: JSON.stringify(body) });

async function setup() {
  t = await makeNode();
  mkdirSync(join(t.project, 'src'), { recursive: true });
  mkdirSync(join(t.project, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(t.project, 'src', 'main.ts'), 'export const a = 1;\n');
  writeFileSync(join(t.project, 'README.md'), '# hi\n');
  writeFileSync(join(t.project, 'blob.bin'), Buffer.from([1, 0, 2, 3]));
  const p = await post('/projects', { path: t.project });
  return `/projects/${p.body.id}/files`;
}

describe('files api', () => {
  it('lists the tree (dirs first, ignored dirs hidden) and reads files', async () => {
    const f = await setup();
    const tree = await call(`${f}/tree`);
    assert.equal(tree.status, 200);
    assert.deepEqual(tree.body.entries.map((e: any) => e.name), ['src', 'blob.bin', 'README.md']);
    assert.equal(tree.body.entries[0].hasChildren, true);
    const sub = await call(`${f}/tree?path=src`);
    assert.deepEqual(sub.body.entries.map((e: any) => e.path), ['src/main.ts']);

    const r = await call(`${f}/read?path=src/main.ts`);
    assert.equal(r.body.content, 'export const a = 1;\n');
    assert.equal(r.body.language, 'typescript');
    assert.equal((await call(`${f}/read?path=blob.bin`)).body.binary, true);
    assert.equal((await call(`${f}/read?path=nope.txt`)).status, 404);
    assert.equal((await call(`${f}/read?path=../../etc/passwd`)).status, 400);
    assert.equal((await call(`${f}/read?path=${encodeURIComponent('/etc/passwd')}`)).status, 400);
  });

  it('writes with optimistic concurrency and emits files:changed', async () => {
    const f = await setup();
    const r = await call(`${f}/read?path=src/main.ts`);
    const w = await post(`${f}/write`, { path: 'src/main.ts', content: 'v2\n', baseMtime: r.body.mtime });
    assert.equal(w.status, 200);
    assert.equal(readFileSync(join(t.project, 'src', 'main.ts'), 'utf8'), 'v2\n');
    // A stale base (someone else wrote since) is refused.
    const stale = await post(`${f}/write`, { path: 'src/main.ts', content: 'v3\n', baseMtime: r.body.mtime - 10_000 });
    assert.equal(stale.status, 409);
    assert.equal(readFileSync(join(t.project, 'src', 'main.ts'), 'utf8'), 'v2\n');
    await t.waitFor(() => t.events.some((e: EventEnvelope) => e.type === 'files:changed' && e.paths.includes('src/main.ts')));
    assert.equal((await post(`${f}/write`, { path: '../evil.txt', content: 'x' })).status, 400);
  });

  it('creates, renames, uploads and deletes', async () => {
    const f = await setup();
    assert.equal((await post(`${f}/create`, { path: 'docs', dir: true })).status, 200);
    assert.equal((await post(`${f}/create`, { path: 'docs/a.md', content: 'A' })).status, 200);
    assert.equal((await post(`${f}/create`, { path: 'docs/a.md' })).status, 409);
    assert.equal((await post(`${f}/rename`, { from: 'docs/a.md', to: 'docs/b.md' })).status, 200);
    assert.ok(existsSync(join(t.project, 'docs', 'b.md')));
    const up = await post(`${f}/upload`, { dir: 'docs', files: [{ name: '../../sneaky.png', content: Buffer.from('png').toString('base64') }] });
    assert.deepEqual(up.body.uploaded.map((u: any) => u.path), ['docs/sneaky.png'], 'names are reduced to a basename');
    assert.equal((await call(`${f}?path=docs`, { method: 'DELETE' })).status, 200);
    assert.ok(!existsSync(join(t.project, 'docs')));
    assert.equal((await call(`${f}?path=`, { method: 'DELETE' })).status, 400, 'never delete the root');
  });

  it('streams raw files with Range support and token-in-query auth', async () => {
    const f = await setup();
    writeFileSync(join(t.project, 'clip.mp4'), Buffer.from('0123456789'));
    const url = `${base()}${f}/raw?path=clip.mp4&token=${t.node.cfg.token}`;
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal(await full.text(), '0123456789');
    const part = await fetch(url, { headers: { Range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await part.text(), '2345');
    assert.equal((await fetch(url, { headers: { Range: 'bytes=50-' } })).status, 416);
    assert.equal((await fetch(`${base()}${f}/raw?path=clip.mp4`)).status, 401);
  });

  it('searches filenames', async () => {
    const f = await setup();
    const s = await call(`${f}/search?q=main`);
    assert.deepEqual(s.body.files.map((x: any) => x.path), ['src/main.ts']);
    assert.deepEqual((await call(`${f}/search?q=x`)).body.files.every((x: any) => !x.path.startsWith('node_modules')), true);
  });

  it('reports git status, diffs and HEAD content', async () => {
    const f = await setup();
    const g = (...a: string[]) => execFileSync('git', a, { cwd: t.project, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    writeFileSync(join(t.project, 'src', 'main.ts'), 'export const a = 2;\n');
    writeFileSync(join(t.project, 'new.txt'), 'n\n');

    const st = await call(`${f}/git-status`);
    assert.equal(st.body.isRepo, true);
    assert.equal(st.body.branch, 'main');
    assert.deepEqual(st.body.entries.sort((a: any, b: any) => a.path.localeCompare(b.path)), [
      { path: 'new.txt', status: '?' }, { path: 'src/main.ts', status: 'M' },
    ]);
    const d = await call(`${f}/diff?path=src/main.ts`);
    assert.equal(d.body.diffs.length, 1);
    assert.deepEqual([d.body.diffs[0].additions, d.body.diffs[0].deletions], [1, 1]);
    assert.equal((await call(`${f}/original?path=src/main.ts`)).body.content, 'export const a = 1;\n');
    assert.equal((await call(`${f}/original?path=new.txt`)).body.content, null);
  });

  it('is not a repo outside git', async () => {
    const f = await setup();
    assert.deepEqual((await call(`${f}/git-status`)).body, { isRepo: false, branch: null, entries: [] });
  });
});
