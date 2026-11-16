import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { FeedItem } from '@axo/protocol';
import { makeNode, call, type TestNode } from './helpers.ts';
import { agentToken } from '../src/util/agent-token.ts';
import { MAX_EXCHANGES } from '../src/innerchat/innerchat.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyAgentToken } from '../src/util/agent-token.ts';

let t: TestNode;
afterEach(async () => { await t?.stop(); });

async function pair(t: TestNode) {
  const p = t.node.projects.create(t.project);
  const a = t.node.runtime.create({ projectId: p.id, name: 'alice', role: 'backend' });
  const b = t.node.runtime.create({ projectId: p.id, name: 'bob', role: 'frontend' });
  return { p, a, b };
}
const users = (t: TestNode, id: string) => t.feed(id).filter((i): i is Extract<FeedItem, { kind: 'user' }> => i.kind === 'user');

/** Run the real axo CLI (dev wrapper in <home>/bin) as an agent would. */
function axo(t: TestNode, agentId: string, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', [t.node.bin.axo, ...args], {
      env: { PATH: process.env.PATH, AXO_NODE_URL: `http://127.0.0.1:${t.node.cfg.port}`, AXO_TOKEN: agentToken(t.node.cfg.token, agentId), AXO_AGENT_ID: agentId },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('innerchat', () => {
  it('ask blocks until the target answers and returns its final text', async () => {
    t = await makeNode();
    const { a, b } = await pair(t);
    const res = await t.node.innerchat.ask(a.id, 'bob', 'what port?');
    assert.equal(res.timedOut, false);
    assert.match(res.reply!, /^echo: \[from alice\] \[InnerChat: alice \(backend\) is asking you a question\]/);
    assert.match(res.reply!, /what port\?/);
    assert.equal(res.exchangesRemaining, MAX_EXCHANGES - 1);

    // Both feeds show the exchange; the target's inbound item is authored by the sender.
    assert.ok(users(t, b.id).some((u) => u.author === 'alice' && u.text.includes('what port?')));
    const mine = users(t, a.id);
    assert.ok(mine.some((u) => u.author === 'alice' && u.text === '[ask → bob] what port?'));
    assert.ok(mine.some((u) => u.author === 'bob' && u.text === res.reply));

    const turns = t.events.filter((e) => e.type === 'innerchat:turn');
    assert.deepEqual(turns.map((e) => (e as any).turn.kind), ['ask', 'answer']);
    const threads = t.node.innerchat.threads(a.id);
    assert.equal(threads.length, 1);
    assert.deepEqual(t.node.innerchat.turns(threads[0].id).map((x) => x.kind), ['ask', 'answer']);
  });

  it('matches the reply to the turn that consumed the question, not the turn already running', async () => {
    t = await makeNode();
    const { a, b } = await pair(t);
    t.node.runtime.deliver(b.id, 'SLOW user work');
    await t.waitFor(() => t.node.runtime.get(b.id).status === 'working');
    const res = await t.node.innerchat.ask(a.id, 'bob', 'quick question', 10_000);
    assert.match(res.reply!, /quick question/);
    assert.doesNotMatch(res.reply!, /SLOW user work/);
  });

  it('tell returns at once and the reply is delivered back to the sender as a message', async () => {
    t = await makeNode();
    const { a } = await pair(t);
    const res = t.node.innerchat.tell(a.id, 'bob', 'FYI the API moved');
    assert.equal(res.delivered, true);
    const back = await t.waitFor(() => users(t, a.id).find((u) => u.author === 'bob'));
    assert.match(back.text, /^\[InnerChat reply from bob \(frontend\)\]/);
    assert.match(back.text, /FYI the API moved/);
    // and alice's process got it as a turn
    await t.waitFor(() => t.feed(a.id).some((i) => i.kind === 'text' && i.text.includes('[from bob] [InnerChat reply from bob')));
  });

  it('a timed-out ask still delivers the late answer as a message', async () => {
    t = await makeNode();
    const { a, b } = await pair(t);
    t.node.runtime.deliver(b.id, 'SLOW busy');
    await t.waitFor(() => t.node.runtime.get(b.id).status === 'working');
    const res = await t.node.innerchat.ask(a.id, 'bob', 'are you there?', 1000);
    assert.equal(res.timedOut, true);
    assert.equal(res.reply, null);
    assert.match(res.note!, /delivered to you as a message/);
    const late = await t.waitFor(() => users(t, a.id).find((u) => u.author === 'bob' && u.text.startsWith('[InnerChat reply')), 5000);
    assert.match(late.text, /are you there\?/);
  });

  it('guards against deadlock, including through a chain', async () => {
    t = await makeNode();
    const { p, a, b } = await pair(t);
    const c = t.node.runtime.create({ projectId: p.id, name: 'carol' });
    // Make b and c busy so their asks stay pending.
    t.node.runtime.deliver(b.id, 'SLOW');
    t.node.runtime.deliver(c.id, 'SLOW');
    await t.waitFor(() => t.node.runtime.get(b.id).status === 'working' && t.node.runtime.get(c.id).status === 'working');
    const ab = t.node.innerchat.ask(a.id, 'bob', 'q1', 5000);       // a → b
    assert.throws(() => t.node.innerchat.ask(b.id, 'alice', 'q2'), /blocked waiting for YOUR answer/);
    const bc = t.node.innerchat.ask(b.id, 'carol', 'q3', 5000);     // b → c
    assert.throws(() => t.node.innerchat.ask(c.id, 'alice', 'q4'), /indirectly/); // c → a would close a→b→c→a
    await Promise.all([ab, bc]);
  });

  it('caps a thread at 12 exchanges; a user message to either agent resets it', async () => {
    t = await makeNode();
    const { a } = await pair(t);
    for (let i = 0; i < MAX_EXCHANGES; i++) t.node.innerchat.tell(a.id, 'bob', `m${i}`);
    assert.throws(() => t.node.innerchat.tell(a.id, 'bob', 'one more'), /12-exchange limit/);
    t.node.runtime.deliver(a.id, 'keep going', 'user');
    assert.equal(t.node.innerchat.tell(a.id, 'bob', 'fresh').exchangesRemaining, MAX_EXCHANGES - 1);
  });

  it('fails a blocked ask when the target is stopped or ends its turn silently', async () => {
    t = await makeNode();
    const { a, b } = await pair(t);
    const silent = await t.node.innerchat.ask(a.id, 'bob', 'SILENT please');
    assert.equal(silent.reply, null);
    assert.match(silent.note!, /bob ended its turn without answering/);

    t.node.runtime.deliver(b.id, 'SLOW');
    await t.waitFor(() => t.node.runtime.get(b.id).status === 'working');
    const pending = t.node.innerchat.ask(a.id, 'bob', 'hello?', 10_000);
    await t.node.runtime.stop(b.id);
    const res = await pending;
    assert.match(res.note!, /bob was stopped before answering/);
  });

  it('resolves name@team, rejects unknown names with the roster, and rejects self-messages', async () => {
    t = await makeNode();
    const { p, a } = await pair(t);
    const team = t.node.teams.create({ projectId: p.id, name: 'ops' });
    t.node.runtime.create({ projectId: p.id, teamId: team.id, name: 'dave' });
    assert.equal(t.node.innerchat.resolve(t.node.runtime.get(a.id), 'dave@ops').name, 'dave');
    assert.equal(t.node.innerchat.resolve(t.node.runtime.get(a.id), 'BOB').name, 'bob');
    assert.throws(() => t.node.innerchat.resolve(t.node.runtime.get(a.id), 'zed'), /Agents you can reach: bob, dave/);
    assert.throws(() => t.node.innerchat.resolve(t.node.runtime.get(a.id), 'dave@prod'), /no team "prod"/);
    assert.throws(() => t.node.innerchat.tell(a.id, 'alice', 'hi'), /cannot message yourself/);
  });

  it('takes the sender from the agent token, never from the body', async () => {
    t = await makeNode();
    const { a, b } = await pair(t);
    const tok = agentToken(t.node.cfg.token, a.id);
    const res = await call(t, '/innerchat/tell', { method: 'POST', body: JSON.stringify({ from: b.id, to: 'bob', message: 'hi' }) }, tok);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(users(t, b.id).some((u) => u.author === 'alice'), 'sent as alice despite from=bob');
  });

  it('works end to end through the axo CLI: who, ask, tell, status', async () => {
    t = await makeNode();
    const { a } = await pair(t);
    const who = await axo(t, a.id, 'who');
    assert.equal(who.code, 0, who.stderr);
    assert.match(who.stdout, /You are alice/);
    assert.match(who.stdout, /bob +\(frontend, team main/);

    const ask = await axo(t, a.id, 'ask', 'bob', 'what', 'is', 'the', 'schema?');
    assert.equal(ask.code, 0, ask.stderr);
    assert.match(ask.stdout, /what is the schema\?/);
    assert.match(ask.stderr, /blocks until they answer/);

    const tell = await axo(t, a.id, 'tell', 'bob', 'done with auth');
    assert.match(tell.stdout, /Delivered to bob/);

    const status = await axo(t, a.id, 'status');
    assert.match(status.stdout, /^alice \(backend\)/);
    assert.match(status.stdout, /team main/);

    const bad = await axo(t, a.id, 'ask', 'nobody', 'hi');
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /no agent named "nobody".*bob/);
  });

  it('a pending ask survives a rotation of the target: same agent id, reply still arrives', async () => {
    t = await makeNode({}, {}, { journalist: { debounceMs: 30 } });
    writeFileSync(join(t.fakeDir, 'headless.json'), JSON.stringify([
      { match: 'working-state document for an AI coding agent', reply: '## Mission\nx\n## Plan\n1. [ ] y\n## Now\nz' },
      { match: 'You write handoff briefs', reply: '## Where things stand\nok\n## Exactly what to do next\ncontinue' },
      { match: 'Your context is about to be refreshed', reply: '## Where things stand\nok\n## Exactly what to do next\ncontinue\n' + 'detail '.repeat(40) },
      { match: 'understood its handoff', reply: 'PASS' },
    ]));
    const { a, b } = await pair(t);
    t.node.runtime.deliver(b.id, 'SLOW warmup work');
    await t.waitFor(() => t.node.runtime.get(b.id).status === 'working');
    const asked = t.node.innerchat.ask(a.id, 'bob', 'still there after your refresh?', 20_000);
    await t.node.rotator.rotate(b.id, { reason: 'manual' });
    assert.equal(t.node.runtime.get(b.id).generation, 1);
    const res = await asked;
    assert.equal(res.timedOut, false, res.note);
    assert.match(res.reply!, /still there after your refresh\?/);

    // The rotator's warm-up process got the knock hook and bob's own token too.
    const warm = t.spawns().filter((s) => s.args.includes('--input-format')).at(-1)!;
    assert.ok(warm.args.includes('--settings'));
    assert.equal(verifyAgentToken(t.node.cfg.token, warm.env.AXO_TOKEN), b.id);
  });
});
