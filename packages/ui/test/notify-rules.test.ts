import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, EventEnvelope, FeedItem, Watch } from '@axo/protocol';
import { NotifyRules, lastQuestion, STALE_MS, type RuleContext } from '../src/lib/notify-rules.ts';

const NOW = 1_000_000_000;
let seq = 0;
const env = (ev: any, ts = NOW): EventEnvelope => ({ ...ev, seq: ++seq, ts, nodeId: 'n' });
const agent = (p: Partial<Agent> = {}): Agent => ({
  id: 'a1', projectId: 'p', teamId: 't', name: 'backend-1', role: 'backend', model: 'opus', effort: null, scopeGlobs: [], instructions: '',
  workdir: '/w', status: 'idle', sessionId: null, generation: 0, queued: 0, contextTokens: 0, contextWindow: 200000, sessionTokens: 0,
  compactions: 0, lastError: null, createdAt: 0, lastActiveAt: 0, ...p,
});

function harness(nodeName = 'Local') {
  const rules = new NotifyRules();
  let current = agent({ status: 'working' });
  const ctx: RuleContext = { nodeName, agent: (id) => (id === current.id ? current : undefined), now: NOW };
  const feed = (item: Partial<FeedItem> & { kind: FeedItem['kind'] }, i = 0) =>
    rules.handle('local', env({ type: 'agent:feed', agentId: 'a1', item: { id: `f${seq}${i}`, ts: NOW, ...item } }), ctx);
  /** Simulates the store: the event sees the old agent, then the store applies it. */
  const upsert = (p: Partial<Agent>, ts = NOW) => {
    const next = agent({ ...current, ...p });
    const r = rules.handle('local', env({ type: 'agent:upsert', agent: next }, ts), ctx);
    current = next;
    return r;
  };
  return { rules, ctx, feed, upsert, setStatus: (s: Agent['status']) => { current = agent({ ...current, status: s }); } };
}

test('turn finished → notification with the last prose', () => {
  const h = harness();
  h.feed({ kind: 'user', text: 'fix the tests', author: 'user' } as any);
  h.feed({ kind: 'text', text: 'All 40 tests pass now.' } as any);
  h.feed({ kind: 'turn', isError: false, durationMs: 1, costUsd: 0, numTurns: 1 } as any);
  const n = h.upsert({ status: 'idle' })!;
  assert.equal(n.title, 'backend-1 finished');
  assert.equal(n.body, 'All 40 tests pass now.');
  assert.equal(n.agentId, 'a1');
});

test('ending on a question → "has a question", remote node named', () => {
  const h = harness('prod-1');
  h.feed({ kind: 'user', text: 'migrate', author: 'user' } as any);
  h.feed({ kind: 'text', text: 'I found two schemas.\n\nThe old one has data. Should I drop it or migrate it first?' } as any);
  const n = h.upsert({ status: 'idle' })!;
  assert.equal(n.title, 'backend-1 has a question · prod-1');
  assert.equal(n.body, 'Should I drop it or migrate it first?');
});

test('silent cases: interrupted, more queued, InnerChat reply, refresh end, stale replay, still busy', () => {
  let h = harness();
  h.feed({ kind: 'user', text: 'x', author: 'user' } as any);
  h.feed({ kind: 'turn', isError: true, durationMs: 1, costUsd: 0, numTurns: 1, interrupted: true } as any);
  assert.equal(h.upsert({ status: 'idle' }), null);

  h = harness();
  assert.equal(h.upsert({ status: 'idle', queued: 2 }), null);

  h = harness();
  h.feed({ kind: 'user', text: 'what port?', author: 'frontend-1' } as any);
  h.feed({ kind: 'text', text: '31500' } as any);
  assert.equal(h.upsert({ status: 'idle' }), null);

  h = harness();
  h.setStatus('rotating');
  assert.equal(h.upsert({ status: 'idle' }), null);

  h = harness();
  assert.equal(h.upsert({ status: 'idle' }, NOW - STALE_MS - 1), null);

  h = harness();
  assert.equal(h.upsert({ status: 'working', queued: 1 }), null);
});

test('watch results are woken by the watch and still notify once', () => {
  const h = harness();
  const w = (status: Watch['status'], result: Watch['result']): EventEnvelope => env({ type: 'watch:upsert', watch: {
    id: 'w1', agentId: 'a1', agentName: 'backend-1', teamId: null, label: 'npm test', mode: 'command', command: 'npm test', until: '', cwd: '/w',
    timeoutMs: 1, status, createdAt: 0, finishedAt: 1, result } });
  assert.equal(h.rules.handle('local', w('active', null), h.ctx), null);
  const n = h.rules.handle('local', w('delivered', { outcome: 'failure', exitCode: 1, summary: '3 failing', output: '' }), h.ctx)!;
  assert.equal(n.title, 'Watch failed: npm test');
  assert.equal(n.body, 'backend-1 · 3 failing');
  assert.equal(h.rules.handle('local', w('delivered', { outcome: 'failure', exitCode: 1, summary: '3 failing', output: '' }), h.ctx), null);
});

test('errors and aborted refreshes notify', () => {
  const h = harness();
  assert.equal(h.upsert({ status: 'error', lastError: 'claude exited 1' })!.title, 'backend-1 stopped with an error');
  const n = h.rules.handle('local', env({ type: 'rotation:aborted', agentId: 'a1', reason: 'state doc empty' }), h.ctx)!;
  assert.equal(n.title, 'Context refresh aborted: backend-1');
});

test('lastQuestion only fires on a trailing question', () => {
  assert.equal(lastQuestion('Done. Want me to push?'), 'Want me to push?');
  assert.equal(lastQuestion('Should I? I did it anyway.'), null);
  assert.equal(lastQuestion('Use `foo()`?'), 'Use `foo()`?');
  assert.equal(lastQuestion(''), null);
});
