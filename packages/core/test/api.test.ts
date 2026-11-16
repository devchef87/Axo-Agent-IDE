import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import type { EventEnvelope, NodeState } from '@axo/protocol';
import { makeNode, type TestNode } from './helpers.ts';

let t: TestNode;
afterEach(async () => { await t?.stop(); });

const base = () => `http://127.0.0.1:${t.node.cfg.port}/api`;
const call = async (path: string, init: RequestInit = {}, token = t.node.cfg.token) => {
  const res = await fetch(base() + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() as any };
};

describe('api', () => {
  it('requires the bearer token (except health)', async () => {
    t = await makeNode();
    assert.equal((await fetch(base() + '/health')).status, 200);
    assert.equal((await call('/state', {}, 'wrong')).status, 401);
    assert.equal((await call('/state')).status, 200);
  });

  it('creates a project and agent, chats over REST, streams over WS', async () => {
    t = await makeNode();
    const ws = new WebSocket(`ws://127.0.0.1:${t.node.cfg.port}/ws?token=${t.node.cfg.token}`);
    const got: EventEnvelope[] = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));

    const p = await call('/projects', { method: 'POST', body: JSON.stringify({ path: t.project }) });
    assert.equal(p.status, 200);
    const a = await call('/agents', { method: 'POST', body: JSON.stringify({ projectId: p.body.id, name: 'ws-agent', task: 'hi there' }) });
    assert.equal(a.status, 200);
    await t.waitFor(() => got.some((e) => e.type === 'agent:feed' && e.item.kind === 'turn'));
    assert.equal(got[0].type, 'hello');

    const feed = await call(`/agents/${a.body.id}/feed`);
    assert.deepEqual(feed.body.items.map((i: any) => i.kind), ['user', 'text', 'turn']);

    const state = (await call('/state')).body as NodeState;
    assert.equal(state.agents[0].name, 'ws-agent');
    assert.equal(state.teams.length, 1);

    const dup = await call('/agents', { method: 'POST', body: JSON.stringify({ projectId: p.body.id, name: 'ws-agent' }) });
    assert.equal(dup.status, 409);
    ws.close();
  });

  it('replays missed events by seq and signals reset across restarts', async () => {
    t = await makeNode();
    const s0 = (await call('/state')).body as NodeState;
    await call('/projects', { method: 'POST', body: JSON.stringify({ path: t.project }) });
    const page = (await call(`/events?since=${s0.seq}&epoch=${s0.epoch}`)).body;
    assert.equal(page.reset, false);
    assert.ok(page.events.some((e: any) => e.type === 'project:upsert'));

    await t.restart();
    const after = (await call(`/events?since=${page.seq}&epoch=${s0.epoch}`)).body;
    assert.equal(after.reset, true);
  });

  it('returns 400s for bad input', async () => {
    t = await makeNode();
    assert.equal((await call('/projects', { method: 'POST', body: JSON.stringify({ path: '/definitely/not/here' }) })).status, 400);
    assert.equal((await call('/agents/nope/message', { method: 'POST', body: JSON.stringify({ text: 'x' }) })).status, 404);
  });
});
