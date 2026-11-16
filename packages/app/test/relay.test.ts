import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { InnerChatRelay, resolveServer, type RelayEndpoint } from '../src/relay.ts';

/** Minimal node: an outbox, a relay-in inbox and an ack log — the three routes the relay uses. */
interface StubNode {
  ep: RelayEndpoint;
  outbox: { id: string; toServer: string; text: string }[];
  inbox: { envelope: any; fromServer: string }[];
  acks: { id: string; ok: boolean; error?: string }[];
  peers: { id: string; name: string; connected: boolean }[][];
  relayInStatus: number;  // what relay-in answers
  ackStatus: number;
  outboxStatus: number;
  server: Server;
}

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function stub(id: string, name: string, connected = true): Promise<StubNode> {
  const n = { outbox: [], inbox: [], acks: [], peers: [], relayInStatus: 200, ackStatus: 200, outboxStatus: 200 } as unknown as StubNode;
  n.server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer tok-${id}`) { res.statusCode = 403; return res.end('{"error":"forbidden"}'); }
      const send = (status: number, obj: unknown) => { res.statusCode = status; res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && req.url === '/api/innerchat/outbox') return send(n.outboxStatus, n.outboxStatus === 200 ? n.outbox : { error: 'not found' });
      if (req.method === 'PUT' && req.url === '/api/innerchat/peers') { n.peers.push(JSON.parse(body).servers); return send(200, { ok: true }); }
      if (req.method === 'POST' && req.url === '/api/innerchat/relay-in') {
        if (n.relayInStatus !== 200) return send(n.relayInStatus, { error: n.relayInStatus === 404 ? 'no agent named zed; agents: bob' : 'boom' });
        n.inbox.push(JSON.parse(body));
        return send(200, { ok: true });
      }
      const m = /^\/api\/innerchat\/outbox\/([^/]+)\/ack$/.exec(req.url ?? '');
      if (req.method === 'POST' && m) {
        if (n.ackStatus !== 200) return send(n.ackStatus, { error: 'busy' });
        const ack = JSON.parse(body);
        n.acks.push({ id: decodeURIComponent(m[1]), ...ack });
        n.outbox = n.outbox.filter((e) => e.id !== decodeURIComponent(m[1]));
        return send(200, { ok: true });
      }
      send(404, { error: 'not found' });
    });
  });
  servers.push(n.server);
  await new Promise<void>((r) => n.server.listen(0, '127.0.0.1', r));
  n.ep = { id, name, baseUrl: `http://127.0.0.1:${(n.server.address() as any).port}`, token: `tok-${id}`, connected };
  return n;
}

describe('resolveServer', () => {
  const eps: RelayEndpoint[] = [
    { id: 'local', name: 'Local', baseUrl: '', token: '', connected: true },
    { id: 'prod-1', name: 'Production', baseUrl: '', token: '', connected: true },
    { id: 'staging', name: 'Box', baseUrl: '', token: '', connected: false },
    { id: 'box-2', name: 'Box', baseUrl: '', token: '', connected: true },
  ];
  test('ids first, then display names, case-insensitive', () => {
    assert.equal((resolveServer('PROD-1', eps) as any).target.id, 'prod-1');
    assert.equal((resolveServer('production', eps) as any).target.id, 'prod-1');
    assert.equal((resolveServer('local', eps) as any).target.id, 'local');
  });
  test('offline waits, unknown and ambiguous are errors', () => {
    assert.deepEqual(resolveServer('staging', eps), { wait: true });
    assert.match((resolveServer('nope', eps) as any).error, /no server named nope; known: local, prod-1, staging, box-2/);
    assert.match((resolveServer('box', eps) as any).error, /ambiguous; use one of: staging, box-2/);
  });
});

describe('InnerChatRelay', () => {
  test('ask out, answer back: fromServer is the origin id, both acked', async () => {
    const local = await stub('local', 'Local');
    const prod = await stub('prod-1', 'Production');
    const relay = new InnerChatRelay(() => [local.ep, prod.ep]);
    local.outbox.push({ id: 'e1', toServer: 'Production', text: 'which port?' });
    await relay.runOnce();
    assert.equal(prod.inbox.length, 1);
    assert.equal(prod.inbox[0].fromServer, 'local');
    assert.equal(prod.inbox[0].envelope.text, 'which port?'); // passed through untouched
    assert.deepEqual(local.acks, [{ id: 'e1', ok: true }]);
    prod.outbox.push({ id: 'e2', toServer: 'local', text: '31500' });
    await relay.runOnce();
    assert.equal(local.inbox[0].fromServer, 'prod-1');
    assert.deepEqual(prod.acks, [{ id: 'e2', ok: true }]);
  });

  test('unknown server and target rejections are acked as failures', async () => {
    const local = await stub('local', 'Local');
    const prod = await stub('prod-1', 'Production');
    const relay = new InnerChatRelay(() => [local.ep, prod.ep]);
    local.outbox.push({ id: 'u1', toServer: 'staging', text: 'hi' });
    await relay.runOnce();
    assert.equal(local.acks[0].ok, false);
    assert.match(local.acks[0].error!, /no server named staging; known: local, prod-1/);
    prod.relayInStatus = 404;
    local.outbox.push({ id: 'u2', toServer: 'prod-1', text: 'hi zed' });
    await relay.runOnce();
    assert.deepEqual(local.acks[1], { id: 'u2', ok: false, error: 'no agent named zed; agents: bob' });
  });

  test('offline or failing target: no ack, delivered once it is back', async () => {
    const local = await stub('local', 'Local');
    const prod = await stub('prod-1', 'Production', false);
    const relay = new InnerChatRelay(() => [local.ep, prod.ep]);
    local.outbox.push({ id: 'w1', toServer: 'prod-1', text: 'later' });
    await relay.runOnce();
    assert.equal(local.acks.length, 0);
    prod.ep.connected = true;
    prod.relayInStatus = 503;
    await relay.runOnce();
    assert.equal(local.acks.length, 0);
    prod.relayInStatus = 200;
    await relay.runOnce();
    assert.equal(prod.inbox.length, 1);
    assert.deepEqual(local.acks, [{ id: 'w1', ok: true }]);
  });

  test('a failed ack is retried without delivering twice', async () => {
    const local = await stub('local', 'Local');
    const prod = await stub('prod-1', 'Production');
    const relay = new InnerChatRelay(() => [local.ep, prod.ep]);
    local.outbox.push({ id: 'a1', toServer: 'prod-1', text: 'once' });
    local.ackStatus = 503;
    await relay.runOnce();
    await relay.runOnce();
    assert.equal(prod.inbox.length, 1);
    local.ackStatus = 200;
    await relay.runOnce();
    assert.equal(prod.inbox.length, 1);
    assert.deepEqual(local.acks, [{ id: 'a1', ok: true }]);
  });

  test('nodes without the relay routes (older builds) are skipped', async () => {
    const old = await stub('old', 'Old');
    old.outboxStatus = 404;
    const local = await stub('local', 'Local');
    const relay = new InnerChatRelay(() => [old.ep, local.ep]);
    await relay.runOnce();
    assert.equal(local.inbox.length, 0);
  });

  test('pushes the peers list to every connected node on change and after a reconnect', async () => {
    const local = await stub('local', 'Local');
    const prod = await stub('prod-1', 'Production');
    const relay = new InnerChatRelay(() => [local.ep, prod.ep]);
    await relay.runOnce();
    await relay.runOnce();
    assert.equal(local.peers.length, 1); // unchanged list: not re-sent
    assert.deepEqual(prod.peers[0], [{ id: 'local', name: 'Local', connected: true }, { id: 'prod-1', name: 'Production', connected: true }]);
    prod.ep.connected = false;
    await relay.runOnce();
    assert.equal(local.peers.length, 2);
    assert.equal(local.peers[1][1].connected, false);
    prod.ep.connected = true;
    await relay.runOnce();
    assert.equal(prod.peers.length, 2); // re-sent after its reconnect
  });
});
