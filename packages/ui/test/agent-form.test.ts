import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent } from '@axo/protocol';
import { diffAgent, formatAgo, toForm } from '../src/lib/agent-form.ts';

const agent = {
  id: 'a', name: 'backend-1', model: 'opus', effort: null, instructions: 'be brief', scopeGlobs: ['src/**'],
} as unknown as Agent;

describe('agent config form', () => {
  it('sends nothing when unchanged', () => {
    assert.deepEqual(diffAgent(agent, toForm(agent)), {});
  });
  it('sends only changed fields, normalising name, effort and scope', () => {
    const f = { ...toForm(agent), name: '  backend-2 ', effort: 'high', scope: ' src/** \n\n docs/**\n' };
    assert.deepEqual(diffAgent(agent, f), { name: 'backend-2', effort: 'high', scopeGlobs: ['src/**', 'docs/**'] });
    assert.deepEqual(diffAgent({ ...agent, effort: 'high' } as Agent, { ...toForm(agent), effort: '' }), { effort: null });
    assert.deepEqual(diffAgent(agent, { ...toForm(agent), scope: '' }), { scopeGlobs: [] });
  });
});

describe('formatAgo', () => {
  it('reads naturally', () => {
    const now = 1_000_000_000;
    assert.equal(formatAgo(now - 10_000, now), 'just now');
    assert.equal(formatAgo(now - 5 * 60_000, now), '5m ago');
    assert.equal(formatAgo(now - 3 * 3_600_000, now), '3h ago');
  });
});
