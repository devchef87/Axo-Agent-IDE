import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import type { EventEnvelope, NodeState } from '@axo/protocol';
import { makeNode, type TestNode } from './helpers.ts';

let t: TestNode;
afterEach(async () => { await t?.stop(); t = undefined as any; });

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

describe('agent token boundaries', () => {
  it('agent tokens cannot use the file API (header or ?token=)', async () => {
    t = await makeNode();
    const { agentToken } = await import('../src/util/agent-token.ts');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${t.project}/secret.txt`, 'top secret');
    const p = t.node.projects.create(t.project);
    const a = t.node.runtime.create({ projectId: p.id, name: 'snoop' });
    const tok = agentToken(t.node.cfg.token, a.id);
    const base = `http://127.0.0.1:${t.node.cfg.port}/api/projects/${p.id}/files`;
    const viaHeader = await fetch(`${base}/read?path=secret.txt`, { headers: { Authorization: `Bearer ${tok}` } });
    assert.equal(viaHeader.status, 401);
    const viaQuery = await fetch(`${base}/raw?path=secret.txt&token=${encodeURIComponent(tok)}`);
    assert.equal(viaQuery.status, 401);
    const owner = await fetch(`${base}/raw?path=secret.txt&token=${encodeURIComponent(t.node.cfg.token)}`);
    assert.equal(owner.status, 200);
    assert.equal(await owner.text(), 'top secret');
  });
});
