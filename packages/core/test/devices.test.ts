import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { makeNode, call, type TestNode } from './helpers.ts';
import { agentToken } from '../src/util/agent-token.ts';
import { TailscaleListener } from '../src/devices/devices.ts';

const freePort = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
const wsOpen = (url: string) => new Promise<WebSocket & { first: Promise<any> }>((res, rej) => {
  const ws = new WebSocket(url) as WebSocket & { first: Promise<any> };
  ws.first = new Promise((r) => ws.once('message', (d) => r(JSON.parse(String(d))))); // hello can arrive with 'open'
  ws.on('open', () => res(ws));
  ws.on('unexpected-response', (_q, r) => rej(new Error(`HTTP ${r.statusCode}`)));
  ws.on('error', rej);
});

describe('mobile devices', () => {
  let t: TestNode;
  afterEach(async () => { await t?.stop(); t = undefined as any; });

  async function withAgent() {
    t = await makeNode();
    const p = await call(t, '/projects', { method: 'POST', body: JSON.stringify({ path: t.project }) });
    const a = await call(t, '/agents', { method: 'POST', body: JSON.stringify({ projectId: p.body.id, name: 'bob' }) });
    const d = await call(t, '/devices', { method: 'POST', body: JSON.stringify({ name: 'Pixel' }) });
    assert.equal(d.status, 200);
    assert.match(d.body.token, /^axd_/);
    return { agentId: a.body.id as string, device: d.body };
  }

  it('a device token can read, message and stop agents, and nothing else', async () => {
    const { agentId, device } = await withAgent();
    const tok = device.token;
    for (const path of ['/version', '/state', '/events?since=0', `/agents/${agentId}/feed`]) {
      assert.equal((await call(t, path, {}, tok)).status, 200, path);
    }
    assert.equal((await call(t, `/agents/${agentId}/message`, { method: 'POST', body: JSON.stringify({ text: 'from the phone', author: 'alice' }) }, tok)).status, 200);
    await t.waitFor(() => t.feed(agentId).some((i) => i.kind === 'user' && i.text === 'from the phone' && i.author === 'user'));
    // the drawer's preview comes with the agent, no feed request per agent
    const st = (await call(t, '/state', {}, tok)).body;
    assert.ok(st.agents[0].preview?.text, 'agent carries a last-message preview');
    assert.notEqual((await call(t, `/agents/${agentId}/images/none`, {}, tok)).status, 401, 'tool-result images are readable');
    assert.equal((await call(t, `/agents/${agentId}/interrupt`, { method: 'POST' }, tok)).status, 200);
    // attachments from the phone land in the agent's folder, out of git, with sanitized timestamped names
    const up = await call(t, `/agents/${agentId}/attachments`, { method: 'POST', body: JSON.stringify({ files: [{ name: '../../evil photo.jpg', content: Buffer.from('jpegbytes').toString('base64') }] }) }, tok);
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const [p] = up.body.paths as string[];
    const wd = (await call(t, '/state')).body.agents[0].workdir.replace(/\/+$/, '');
    assert.ok(p.startsWith(`${wd}/.axo/uploads/`) && /-evil_photo\.jpg$/.test(p), p);
    assert.equal(readFileSync(p, 'utf8'), 'jpegbytes');
    assert.equal(readFileSync(join(wd, '.axo/uploads/.gitignore'), 'utf8'), '*\n');
    assert.equal((await call(t, `/agents/${agentId}/attachments`, { method: 'POST', body: '{"files":[]}' }, tok)).status, 400);
    for (const [method, path] of [['GET', '/devices'], ['POST', '/devices'], ['GET', '/terminals'], ['POST', '/terminals'], ['DELETE', `/agents/${agentId}`],
      ['POST', '/agents'], ['PATCH', `/agents/${agentId}`], ['GET', '/innerchat/outbox'], ['PUT', '/settings/tailscale'], ['GET', `/agents/${agentId}/state`]]) {
      assert.equal((await call(t, path, { method, body: method === 'GET' ? undefined : '{}' }, tok)).status, 401, `${method} ${path}`);
    }
    // the list never exposes tokens
    const list = (await call(t, '/devices')).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].token, undefined);
    assert.ok(list[0].lastSeenAt);
  });

  it('streams events over /ws, and revoking closes the socket and kills the token', async () => {
    const { device } = await withAgent();
    const ws = await wsOpen(`ws://127.0.0.1:${t.node.cfg.port}/ws?token=${device.token}`);
    const hello = await ws.first;
    assert.equal(hello.type, 'hello');
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    assert.equal((await call(t, `/devices/${device.id}`, { method: 'DELETE' })).status, 200);
    assert.equal(await closed, 4401);
    assert.equal((await call(t, '/state', {}, device.token)).status, 401);
    await assert.rejects(wsOpen(`ws://127.0.0.1:${t.node.cfg.port}/ws?token=${device.token}`), /HTTP 401/);
  });

  it('the Tailscale listener accepts phone and node tokens but never agent tokens or terminals', async () => {
    const { device } = await withAgent();
    const port = await freePort();
    const ts = new TailscaleListener(t.home, () => port, () => '127.0.0.1');
    ts.start(t.node.server!);
    assert.equal(ts.settings().url, null, 'off until enabled');
    const s = await ts.set(true);
    assert.equal(s.url, `http://127.0.0.1:${port}`);
    assert.equal(JSON.parse(readFileSync(join(t.home, 'settings.json'), 'utf8')).listenTailscale, true);
    const ext = (path: string, token: string) => fetch(`http://127.0.0.1:${port}/api${path}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.status);
    const agentTok = agentToken(t.node.cfg.token, 'a1b2c3');
    assert.equal(await ext('/version', agentTok), 401, 'agent token off-box');
    assert.equal((await call(t, '/version', {}, agentTok)).status, 200, 'agent token still fine locally');
    assert.equal(await ext('/state', device.token), 200);
    assert.equal(await ext('/state', t.node.cfg.token), 200);
    const term = await call(t, '/terminals', { method: 'POST', body: '{}' });
    await assert.rejects(wsOpen(`ws://127.0.0.1:${port}/ws/term/${term.body.id}?token=${t.node.cfg.token}`), /HTTP 401/);
    const ws = await wsOpen(`ws://127.0.0.1:${port}/ws?token=${device.token}`);
    ws.close();
    await ts.set(false);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/version`));
    await ts.stop();
    assert.ok(existsSync(join(t.home, 'settings.json')));
  });
});
