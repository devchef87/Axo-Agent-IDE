import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedItem } from '@axo/protocol';
import { makeNode, call, type TestNode } from './helpers.ts';
import { agentToken } from '../src/util/agent-token.ts';

let t: TestNode;
afterEach(async () => { await t?.stop(); });

const fromWatch = (t: TestNode, id: string) =>
  t.feed(id).filter((i): i is Extract<FeedItem, { kind: 'user' }> => i.kind === 'user' && i.author === 'watch');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function setup(t: TestNode) {
  const p = t.node.projects.create(t.project);
  return t.node.runtime.create({ projectId: p.id, name: 'trainer' });
}

describe('watches', () => {
  it('runs a command detached and wakes the agent by id with the exit code and output tail', async () => {
    t = await makeNode();
    const a = setup(t);
    const { watch } = t.node.watches.create({ agentId: a.id, command: 'echo step 1; echo step 2; exit 3', label: 'train' });
    assert.equal(watch.status, 'active');
    const msg = await t.waitFor(() => fromWatch(t, a.id)[0]);
    assert.match(msg.text, new RegExp(`^\\[Watch ${watch.id} fired: "train"\\]`));
    assert.match(msg.text, /exit code 3/);
    assert.match(msg.text, /step 1\nstep 2/);
    const done = t.node.watches.get(watch.id);
    assert.equal(done.status, 'delivered');
    assert.equal(done.result?.outcome, 'failure');
    assert.equal(done.result?.exitCode, 3);
    assert.ok(t.events.some((e) => e.type === 'watch:upsert' && e.watch.id === watch.id && e.watch.status === 'delivered'));
    // The agent was woken: its process ran a turn for the message.
    await t.waitFor(() => t.feed(a.id).some((i) => i.kind === 'text' && i.text.includes('[from watch]')));
  });

  it('until mode fires when the check first succeeds', async () => {
    t = await makeNode();
    const a = setup(t);
    const flag = join(t.project, 'ready.flag');
    const { watch } = t.node.watches.create({ agentId: a.id, until: `test -f ${flag} && echo ready`, intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(t.node.watches.get(watch.id).status, 'active');
    writeFileSync(flag, '');
    const msg = await t.waitFor(() => fromWatch(t, a.id)[0]);
    assert.match(msg.text, /condition is now true/);
    assert.match(msg.text, /ready/);
  });

  it('times out with a clear message', async () => {
    t = await makeNode();
    const a = setup(t);
    const { watch } = t.node.watches.create({ agentId: a.id, command: 'sleep 30', timeoutMs: 1000 });
    const msg = await t.waitFor(() => fromWatch(t, a.id)[0], 4000);
    assert.match(msg.text, /Hit its 1s time limit/);
    assert.equal(t.node.watches.get(watch.id).result?.outcome, 'timeout');
    t.node.watches.cancel(watch.id); // no-op on a finished watch
  });

  it('survives a node restart: the job keeps running and the re-armed watch wakes the agent', async () => {
    t = await makeNode();
    const a = setup(t);
    const { watch } = t.node.watches.create({ agentId: a.id, command: 'sleep 1; echo finished' });
    await t.restart(); // node down while the job runs
    const msg = await t.waitFor(() => fromWatch(t, a.id)[0], 6000);
    assert.match(msg.text, /exit code 0/);
    assert.match(msg.text, /finished/);
    assert.equal(t.node.watches.get(watch.id).status, 'delivered');
  });

  it('reports a job that vanished while the node was down', async () => {
    t = await makeNode();
    const a = setup(t);
    const { watch } = t.node.watches.create({ agentId: a.id, command: 'sleep 30' });
    const pid = (t.node.store.db.prepare('SELECT pid FROM watches WHERE id = ?').get(watch.id) as any).pid as number;
    process.kill(-pid, 'SIGKILL'); // dies without writing its exit sentinel
    await t.waitFor(() => !alive(pid));
    await t.restart();
    const msg = await t.waitFor(() => fromWatch(t, a.id)[0]);
    assert.match(msg.text, /lost while the node was down/);
  });

  it('re-attaches instead of starting a duplicate job, caps active watches at 5, cancel kills the job', async () => {
    t = await makeNode();
    const a = setup(t);
    const first = t.node.watches.create({ agentId: a.id, command: 'sleep 30' });
    const again = t.node.watches.create({ agentId: a.id, command: 'sleep 30' });
    assert.equal(again.reattached, true);
    assert.equal(again.watch.id, first.watch.id);
    for (let i = 0; i < 4; i++) t.node.watches.create({ agentId: a.id, command: `sleep 3${i + 1}` });
    assert.throws(() => t.node.watches.create({ agentId: a.id, command: 'sleep 40' }), /already have 5 active watches/);

    const pid = (t.node.store.db.prepare('SELECT pid FROM watches WHERE id = ?').get(first.watch.id) as any).pid as number;
    assert.ok(alive(pid));
    t.node.watches.cancel(first.watch.id);
    assert.equal(t.node.watches.get(first.watch.id).status, 'cancelled');
    await t.waitFor(() => !alive(pid));
    for (const w of t.node.watches.list({ agentId: a.id })) if (w.status === 'active') t.node.watches.cancel(w.id);
    assert.equal(fromWatch(t, a.id).length, 0, 'cancelled watches do not wake the agent');
  });

  it('cancels an agent\'s watches when the agent is deleted', async () => {
    t = await makeNode();
    const a = setup(t);
    const { watch } = t.node.watches.create({ agentId: a.id, command: 'sleep 30' });
    await t.node.runtime.remove(a.id);
    assert.equal(t.node.watches.get(watch.id).status, 'cancelled');
  });

  it('REST + CLI: agent tokens create and see only their own watches', async () => {
    t = await makeNode();
    const a = setup(t);
    const other = t.node.runtime.create({ projectId: a.projectId, name: 'other' });
    const env = { PATH: process.env.PATH, AXO_NODE_URL: `http://127.0.0.1:${t.node.cfg.port}`, AXO_TOKEN: agentToken(t.node.cfg.token, a.id), AXO_AGENT_ID: a.id };
    const out = await new Promise<string>((resolve) => {
      const c = spawn('sh', [t.node.bin.axo, 'watch', 'echo from-cli', '--label', 'cli job'], { env });
      let s = '';
      c.stdout.on('data', (d) => { s += d; });
      c.on('close', () => resolve(s));
    });
    assert.match(out, /Watch \w+ started: "cli job"/);
    const msg = await t.waitFor(() => fromWatch(t, a.id)[0]);
    assert.match(msg.text, /from-cli/);

    const mine = await call(t, '/watches', {}, env.AXO_TOKEN);
    assert.equal(mine.body.length, 1);
    const theirs = await call(t, '/watches', {}, agentToken(t.node.cfg.token, other.id));
    assert.equal(theirs.body.length, 0);
    assert.equal((await call(t, `/watches/${mine.body[0].id}/cancel`, { method: 'POST' }, agentToken(t.node.cfg.token, other.id))).status, 404);
    const output = await call(t, `/watches/${mine.body[0].id}/output`);
    assert.match(output.body.output, /from-cli/);
    assert.ok(existsSync(join(t.home, 'watches', mine.body[0].id, 'out.log')));
  });
});
