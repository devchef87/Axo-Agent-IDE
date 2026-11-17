// Pure-logic tests: `npm test` (node:test with native type stripping; no React Native needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeedItem } from '@axo/protocol';

(globalThis as any).__DEV__ = false;
const { isAllowedUrl, parsePairing } = await import('../src/lib/pairing.ts');
const { foldText, previewOf, senderOf, toBlocks } = await import('../src/lib/feed.ts');

test('only Tailscale addresses are allowed over http', () => {
  assert.ok(isAllowedUrl('http://100.101.102.103:31500'));
  assert.ok(isAllowedUrl('http://100.64.0.1:31500'));
  assert.ok(isAllowedUrl('http://100.127.255.255:31500'));
  assert.ok(isAllowedUrl('http://spark.tail1234.ts.net:31500'));
  assert.ok(isAllowedUrl('https://example.com'));
  assert.ok(!isAllowedUrl('http://100.128.0.1:31500'));
  assert.ok(!isAllowedUrl('http://100.63.0.1:31500'));
  assert.ok(!isAllowedUrl('http://192.168.1.10:31500'));
  assert.ok(!isAllowedUrl('http://localhost:31500')); // dev builds only
  assert.ok(!isAllowedUrl('ftp://100.101.102.103'));
  assert.ok(!isAllowedUrl('nonsense'));
});

test('parsePairing reads the QR payload and trims trailing slashes', () => {
  const nodes = parsePairing(JSON.stringify({ v: 1, nodes: [
    { id: 'axom-spark', name: 'Axom Spark', url: 'http://100.101.102.103:31500/', token: 't1' },
    { id: 'box', url: 'http://box.tail1.ts.net:31500', token: 't2' },
    { id: 'bad-entry' },
  ] }));
  assert.deepEqual(nodes, [
    { id: 'axom-spark', name: 'Axom Spark', url: 'http://100.101.102.103:31500', token: 't1' },
    { id: 'box', name: 'box', url: 'http://box.tail1.ts.net:31500', token: 't2' },
  ]);
});

test('parsePairing rejects junk, wrong versions, empty lists and non-Tailscale URLs', () => {
  assert.throws(() => parsePairing('hello'), /isn't an Axo pairing code/);
  assert.throws(() => parsePairing('{"v":2,"nodes":[]}'), /isn't an Axo pairing code/);
  assert.throws(() => parsePairing('{"v":1,"nodes":[]}'), /no servers/);
  assert.throws(() => parsePairing('{"v":1,"nodes":[{"id":"x","name":"X","url":"http://10.0.0.5:31500","token":"t"}]}'), /X: .* not a Tailscale address/);
});

const base = { ts: 1 };
const tool = (id: string, status: 'running' | 'ok' | 'error' = 'ok'): FeedItem => ({ ...base, id, kind: 'tool', tool: 'Bash', summary: 'ls', input: {}, status });

test('toBlocks groups consecutive tools and appends drafts', () => {
  const items: FeedItem[] = [
    { ...base, id: 'u1', kind: 'user', text: 'go', author: 'user' },
    tool('t1'), tool('t2'),
    { ...base, id: 'x1', kind: 'text', text: 'done' },
    tool('t3', 'running'),
  ];
  const b = toBlocks(items, { 'm-0': 'stream' });
  assert.deepEqual(b.map((x) => x.type), ['item', 'tools', 'item', 'tools', 'draft']);
  assert.equal(b[1].type === 'tools' && b[1].items.length, 2);
  assert.equal(b[4].id, 'd-m-0');
});

test('foldText folds long text only', () => {
  assert.equal(foldText('a\nb'), null);
  const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const f = foldText(long)!;
  assert.equal(f.totalLines, 30);
  assert.equal(f.head.split('\n').length, 8);
});

test('senderOf and previewOf', () => {
  assert.equal(senderOf('user'), 'you');
  assert.equal(senderOf('watch'), 'watch');
  assert.equal(senderOf('axo'), 'axo');
  assert.equal(senderOf('Axo-Manager'), 'agent');
  assert.deepEqual(previewOf({ ts: 5, id: 'a', kind: 'text', text: '## Done\n\n**All** tests `pass`' }), { text: 'Done All tests pass', ts: 5, author: undefined });
  assert.equal(previewOf(tool('t')), null);
  assert.equal(previewOf({ ts: 1, id: 'u', kind: 'user', text: 'hi', author: 'user' })?.author, 'user');
});
