import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { makeNode, call, type TestNode } from './helpers.ts';
import { agentToken } from '../src/util/agent-token.ts';
import { Terminals } from '../src/terminal/terminals.ts';

interface Conn { ws: WebSocket; out: () => string; exit: Promise<number>; closed: Promise<void> }

function attach(t: TestNode, id: string, token = t.node.cfg.token): Promise<Conn> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${t.node.cfg.port}/ws/term/${id}?token=${token}`);
    let buf = '';
    let onExit!: (c: number) => void;
    const exit = new Promise<number>((r) => { onExit = r; });
    const closed = new Promise<void>((r) => ws.on('close', () => r()));
    ws.on('message', (d: Buffer, bin: boolean) => {
      if (bin) buf += d.toString();
      else { const m = JSON.parse(d.toString()); if (m.type === 'exit') onExit(m.code); }
    });
    ws.on('open', () => res({ ws, out: () => buf, exit, closed }));
    ws.on('unexpected-response', (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
    ws.on('error', rej);
  });
}
const send = (c: Conn, s: string) => c.ws.send(Buffer.from(s), { binary: true });

describe('terminals', () => {
  let t: TestNode;
  afterEach(async () => { await t?.stop(); t = undefined as any; });

  it('runs a login shell in a real pty, in the requested cwd, with the internals stripped', async () => {
    process.env.ELECTRON_RUN_AS_NODE = '1';
    t = await makeNode();
    delete process.env.ELECTRON_RUN_AS_NODE;
    const r = await call(t, '/terminals', { method: 'POST', body: JSON.stringify({ cwd: t.project, cols: 100, rows: 30 }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.cwd, t.project);
    const c = await attach(t, r.body.id);
    send(c, 'stty size; pwd -P; echo "tty=$(tty | cut -c1-5) term=$TERM ern=${ELECTRON_RUN_AS_NODE:-unset}"\n');
    await t.waitFor(() => /tty=\/dev\/ term=xterm-256color ern=unset/.test(c.out()), 10_000);
    assert.match(c.out(), /30 100/);
    // resize reaches the pty
    c.ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 40 }));
    send(c, 'stty size\n');
    await t.waitFor(() => /40 132/.test(c.out()), 10_000);
    send(c, 'exit 7\n');
    assert.equal(await c.exit, 7);
    const list = (await call(t, '/terminals')).body;
    assert.equal(list[0].exited, true);
    assert.equal(list[0].exitCode, 7);
  });

  it('survives a detach and replays scrollback on reattach; kill ends it', async () => {
    t = await makeNode();
    const { body: info } = await call(t, '/terminals', { method: 'POST', body: '{}' });
    const a = await attach(t, info.id);
    send(a, 'echo "marker-$((40+2))"\n');
    await t.waitFor(() => a.out().includes('marker-42'), 10_000);
    a.ws.close();
    await a.closed;
    const b = await attach(t, info.id);
    await t.waitFor(() => b.out().includes('marker-42'), 5000);
    assert.equal((await call(t, '/terminals')).body[0].attached, 1);
    assert.equal((await call(t, `/terminals/${info.id}`, { method: 'DELETE' })).status, 200);
    await b.closed;
    assert.deepEqual((await call(t, '/terminals')).body, []);
  });

  it('refuses agent tokens, unknown ids and bad cwds', async () => {
    t = await makeNode();
    const agentTok = agentToken(t.node.cfg.token, 'a1b2c3');
    assert.equal((await call(t, '/terminals', { method: 'POST', body: '{}' }, agentTok)).status, 401);
    const { body: info } = await call(t, '/terminals', { method: 'POST', body: '{}' });
    await assert.rejects(attach(t, info.id, agentTok), /HTTP 401/);
    await assert.rejects(attach(t, 'nope'), /HTTP 404/);
    const bad = await call(t, '/terminals', { method: 'POST', body: JSON.stringify({ cwd: '/definitely/not/here' }) });
    assert.equal(bad.status, 400);
  });

  it('explains a missing python3', async () => {
    const terms = new Terminals({ python: '/nonexistent/python3' });
    await assert.rejects(terms.create({}), /python3/);
    terms.shutdown();
  });

  it('kills shells on node shutdown', async () => {
    t = await makeNode();
    const { body: info } = await call(t, '/terminals', { method: 'POST', body: '{}' });
    await t.stop();
    t = undefined as any;
    await new Promise((r) => setTimeout(r, 500));
    assert.throws(() => process.kill(info.pid, 0), /ESRCH/);
  });
});
