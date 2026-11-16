import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FeedItem, RelayEnvelope } from '@axo/protocol';
import { makeNode, call, type TestNode } from './helpers.ts';
import { agentToken } from '../src/util/agent-token.ts';

let nodes: TestNode[] = [];
let relay: NodeJS.Timeout | null = null;
afterEach(async () => {
  if (relay) clearInterval(relay);
  relay = null;
  for (const n of nodes) await n.stop();
  nodes = [];
});

const users = (t: TestNode, id: string) => t.feed(id).filter((i): i is Extract<FeedItem, { kind: 'user' }> => i.kind === 'user');

/** What the app does: route every node's outbox to the node named in toServer, then ack. */
async function relayOnce(servers: Record<string, TestNode>): Promise<void> {
  for (const [alias, origin] of Object.entries(servers)) {
    const out = await call(origin, '/innerchat/outbox');
    for (const env of out.body as RelayEnvelope[]) {
      const target = Object.entries(servers).find(([a]) => a.toLowerCase() === env.toServer.toLowerCase())?.[1];
      let ack: { ok: boolean; error?: string };
      if (!target) {
        ack = { ok: false, error: `no server named ${env.toServer}; known: ${Object.keys(servers).join(', ')}` };
      } else {
        const res = await call(target, '/innerchat/relay-in', { method: 'POST', body: JSON.stringify({ envelope: env, fromServer: alias }) });
        ack = res.status === 200 ? { ok: true } : { ok: false, error: res.body.error };
      }
      await call(origin, `/innerchat/outbox/${env.id}/ack`, { method: 'POST', body: JSON.stringify(ack) });
    }
  }
}
function startRelay(servers: Record<string, TestNode>) {
  let busy = false;
  relay = setInterval(() => {
    if (busy) return;
    busy = true;
    relayOnce(servers).catch(() => {}).finally(() => { busy = false; });
  }, 40);
}

async function twoNodes() {
  const laptop = await makeNode();
  const server = await makeNode();
  nodes.push(laptop, server);
  const pl = laptop.node.projects.create(laptop.project);
  const ps = server.node.projects.create(server.project);
  const alice = laptop.node.runtime.create({ projectId: pl.id, name: 'alice', role: 'frontend' });
  const bob = server.node.runtime.create({ projectId: ps.id, name: 'bob', role: 'backend' });
  return { laptop, server, alice, bob, servers: { laptop, 'prod-1': server } as Record<string, TestNode> };
}

describe('cross-server innerchat (app relay)', () => {
  it('ask name@server: relayed to the other node, answered, and returned to the blocked asker', async () => {
    const { laptop, server, alice, bob, servers } = await twoNodes();
    startRelay(servers);
    const res = await laptop.node.innerchat.ask(alice.id, 'bob@prod-1', 'which port does the API use?', 10_000);
    assert.equal(res.timedOut, false, res.note);
    assert.match(res.reply!, /^echo: \[from alice@laptop\] \[InnerChat: alice@laptop \(frontend\) is asking you a question\]/);
    assert.match(res.reply!, /which port/);
    assert.ok(users(server, bob.id).some((u) => u.author === 'alice@laptop'));
    assert.ok(users(laptop, alice.id).some((u) => u.author === 'bob@prod-1' && u.text === res.reply));
    // Both sides keep a thread with the remote party, so the loop breaker applies across servers too.
    const local = laptop.node.innerchat.threads(alice.id)[0];
    assert.deepEqual(laptop.node.innerchat.turns(local.id).map((x) => x.kind), ['ask', 'answer']);
    assert.ok(local.participants.some((p) => p.name === 'bob@prod-1'));
    const remote = server.node.innerchat.threads(bob.id)[0];
    assert.deepEqual(server.node.innerchat.turns(remote.id).map((x) => x.kind), ['ask', 'answer']);
    assert.equal((await call(laptop, '/innerchat/outbox')).body.length, 0, 'outbox drained');
  });

  it('tell name@server: the reply comes back as a message', async () => {
    const { laptop, alice, servers } = await twoNodes();
    startRelay(servers);
    const res = laptop.node.innerchat.tell(alice.id, 'bob@PROD-1', 'FYI schema v2 is live');
    assert.equal(res.delivered, true);
    const back = await laptop.waitFor(() => users(laptop, alice.id).find((u) => u.author === 'bob@prod-1'), 8000);
    assert.match(back.text, /^\[InnerChat reply from bob@prod-1 \(backend\)\][\s\S]*FYI schema v2 is live/);
  });

  it('reports unknown servers and unknown agents back to the sender', async () => {
    const { laptop, alice, servers } = await twoNodes();
    startRelay(servers);
    const noServer = await laptop.node.innerchat.ask(alice.id, 'bob@staging', 'hi', 10_000);
    assert.match(noServer.note!, /Could not reach bob@staging: no server named staging; known: laptop, prod-1/);
    const noAgent = await laptop.node.innerchat.ask(alice.id, 'carol@prod-1', 'hi', 10_000);
    assert.match(noAgent.note!, /Could not reach carol@prod-1: no agent named "carol" on this server\. Agents here: bob/);
    laptop.node.innerchat.tell(alice.id, 'zed@prod-1', 'hello');
    const notice = await laptop.waitFor(() => users(laptop, alice.id).find((u) => u.author === 'axo' && /could not be delivered/.test(u.text)), 8000);
    assert.match(notice.text, /Your message to zed@prod-1 could not be delivered/);
  });

  it('a target stopped mid-question answers with an error', async () => {
    const { laptop, server, alice, bob, servers } = await twoNodes();
    server.node.runtime.deliver(bob.id, 'SLOW busy');
    await server.waitFor(() => server.node.runtime.get(bob.id).status === 'working');
    startRelay(servers);
    const pending = laptop.node.innerchat.ask(alice.id, 'bob@prod-1', 'still there?', 10_000);
    await server.waitFor(() => server.node.runtime.list().find((a) => a.id === bob.id)!.queued > 0);
    await server.node.runtime.stop(bob.id);
    const res = await pending;
    assert.match(res.note!, /bob was stopped before answering/);
  });

  it('waits in the outbox while the app is offline (across a node restart); a late answer arrives as a message', async () => {
    const { laptop, alice, servers } = await twoNodes();
    const res = await laptop.node.innerchat.ask(alice.id, 'bob@prod-1', 'are you up?', 1000);
    assert.equal(res.timedOut, true);
    assert.match(res.note!, /Axo app may be closed/);
    assert.equal((await call(laptop, '/innerchat/outbox')).body.length, 1);
    await laptop.restart();
    const pending = (await call(laptop, '/innerchat/outbox')).body as RelayEnvelope[];
    assert.equal(pending.length, 1, 'outbox survives a restart');
    assert.equal(pending[0].toAgent, 'bob');
    startRelay(servers); // app comes back
    const [, server] = nodes;
    await server.waitFor(() => server.node.innerchat.threads().length > 0, 8000);
    await laptop.waitFor(() => (laptop.node.store.db.prepare(`SELECT COUNT(*) n FROM ic_outbox WHERE status = 'delivered'`).get() as any).n === 1, 8000);
    const late = await laptop.waitFor(() => users(laptop, alice.id).find((u) => u.author === 'bob@prod-1' && u.text.startsWith('[InnerChat reply')), 8000);
    assert.match(late.text, /are you up\?/);
  });

  it('a timed-out remote ask still gets its answer later, as a message', async () => {
    const { laptop, server, alice, bob, servers } = await twoNodes();
    server.node.runtime.deliver(bob.id, 'SLOW busy');
    await server.waitFor(() => server.node.runtime.get(bob.id).status === 'working');
    startRelay(servers);
    const res = await laptop.node.innerchat.ask(alice.id, 'bob@prod-1', 'ping?', 1000);
    assert.equal(res.timedOut, true);
    const late = await laptop.waitFor(() => users(laptop, alice.id).find((u) => u.author === 'bob@prod-1' && u.text.startsWith('[InnerChat reply')), 8000);
    assert.match(late.text, /ping\?/);
  });

  it('relay routes reject agent tokens; name@team still means a local team', async () => {
    const { laptop, alice } = await twoNodes();
    const tok = agentToken(laptop.node.cfg.token, alice.id);
    assert.equal((await call(laptop, '/innerchat/outbox', {}, tok)).status, 403);
    assert.equal((await call(laptop, '/innerchat/relay-in', { method: 'POST', body: '{}' }, tok)).status, 403);
    const team = laptop.node.teams.create({ projectId: alice.projectId, name: 'ops' });
    laptop.node.runtime.create({ projectId: alice.projectId, teamId: team.id, name: 'dave' });
    laptop.node.innerchat.tell(alice.id, 'dave@ops', 'local');
    assert.equal((await call(laptop, '/innerchat/outbox')).body.length, 0, 'team address is not relayed');
  });

  it('relay-in is idempotent: a retried envelope is delivered once', async () => {
    const { laptop, server, alice, bob } = await twoNodes();
    laptop.node.innerchat.tell(alice.id, 'bob@prod-1', 'only once please');
    const [env] = (await call(laptop, '/innerchat/outbox')).body as RelayEnvelope[];
    const body = JSON.stringify({ envelope: env, fromServer: 'laptop' });
    assert.equal((await call(server, '/innerchat/relay-in', { method: 'POST', body })).status, 200);
    assert.equal((await call(server, '/innerchat/relay-in', { method: 'POST', body })).status, 200, 'duplicate is ok');
    assert.equal(users(server, bob.id).filter((u) => u.text.includes('only once please')).length, 1);
  });

  it('peers pushed by the app: name@server resolves to the server id, unknown servers fail at once, who lists servers', async () => {
    const { laptop, alice } = await twoNodes();
    const tok = agentToken(laptop.node.cfg.token, alice.id);
    const servers = { servers: [{ id: 'local', name: 'This Mac', connected: true }, { id: 'prod-1', name: 'Prod', connected: false }] };
    assert.equal((await call(laptop, '/innerchat/peers', { method: 'PUT', body: JSON.stringify(servers) }, tok)).status, 403);
    assert.equal((await call(laptop, '/innerchat/peers', { method: 'PUT', body: JSON.stringify(servers) })).status, 200);

    const bad = await call(laptop, '/innerchat/tell', { method: 'POST', body: JSON.stringify({ to: 'bob@staging', message: 'hi' }) }, tok);
    assert.equal(bad.status, 404);
    assert.match(bad.body.error, /no team or server named "staging"\. Servers: local, prod-1/);
    assert.equal((await call(laptop, '/innerchat/outbox')).body.length, 0, 'nothing queued for an unknown server');

    // By display name; queued even while that server is disconnected.
    laptop.node.innerchat.tell(alice.id, 'bob@prod', 'via display name');
    const [env] = (await call(laptop, '/innerchat/outbox')).body as RelayEnvelope[];
    assert.equal(env.toServer, 'prod-1');

    const who = await call(laptop, '/innerchat/who', {}, tok);
    assert.deepEqual(who.body.servers.map((x: any) => x.id), ['local', 'prod-1']);
  });
});
