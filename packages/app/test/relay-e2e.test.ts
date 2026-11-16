// The app's relay between two real core nodes (fake claude): name@server InnerChat end to end.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, call, type TestNode } from '../../core/test/helpers.ts';
import { InnerChatRelay, type RelayEndpoint } from '../src/relay.ts';

let nodes: TestNode[] = [];
let relay: InnerChatRelay | null = null;
afterEach(async () => {
  relay?.stop();
  relay = null;
  for (const n of nodes) await n.stop();
  nodes = [];
});

async function setup() {
  const mac = await makeNode();
  const prod = await makeNode();
  nodes.push(mac, prod);
  const alice = mac.node.runtime.create({ projectId: mac.node.projects.create(mac.project).id, name: 'alice', role: 'frontend' });
  const bob = prod.node.runtime.create({ projectId: prod.node.projects.create(prod.project).id, name: 'bob', role: 'backend' });
  const prodUp = { value: true };
  // What NodeManager.relayEndpoints() returns: this Mac as 'local', servers by ServerConfig.id.
  const endpoints = (): RelayEndpoint[] => [
    { id: 'local', name: 'Local', baseUrl: `http://127.0.0.1:${mac.node.cfg.port}`, token: mac.node.cfg.token, connected: true },
    { id: 'prod-1', name: 'Production', baseUrl: `http://127.0.0.1:${prod.node.cfg.port}`, token: prod.node.cfg.token, connected: prodUp.value },
  ];
  relay = new InnerChatRelay(endpoints);
  relay.start(40);
  return { mac, prod, alice, bob, prodUp };
}

describe('relay e2e (real nodes)', () => {
  it('ask bob@<display name>: delivered, answered, returned to the blocked asker; outboxes drain', async () => {
    const { mac, prod, alice } = await setup();
    const res = await mac.node.innerchat.ask(alice.id, 'bob@Production', 'which port does the API use?', 10_000);
    assert.equal(res.timedOut, false, res.note);
    assert.match(res.reply!, /which port/);
    assert.match(res.reply!, /alice@local/); // the target sees the sender as name@<origin id>
    assert.equal((await call(mac, '/innerchat/outbox')).body.length, 0);
    assert.equal((await call(prod, '/innerchat/outbox')).body.length, 0);
  });

  it('peers are pushed: an unknown @server fails at once with the server list', async () => {
    const { mac, alice } = await setup();
    await new Promise((r) => setTimeout(r, 150)); // a relay round pushes peers
    assert.throws(() => mac.node.innerchat.tell(alice.id, 'bob@staging', 'hi'), /no team or server named "staging"\. Servers: local, prod-1/);
  });

  it('server offline: the message waits, then arrives after it reconnects', async () => {
    const { mac, prod, alice, bob, prodUp } = await setup();
    prodUp.value = false;
    await new Promise((r) => setTimeout(r, 150));
    mac.node.innerchat.tell(alice.id, 'bob@prod-1', 'ping while you were away');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await call(mac, '/innerchat/outbox')).body.length, 1, 'still queued');
    prodUp.value = true;
    await prod.waitFor(() => prod.feed(bob.id).some((i) => i.kind === 'user' && /ping while you were away/.test(i.text)), 5000);
    await mac.waitFor(async () => (await call(mac, '/innerchat/outbox')).body.length === 0, 5000);
  });
});
