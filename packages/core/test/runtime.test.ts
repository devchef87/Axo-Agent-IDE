import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, type TestNode } from './helpers.ts';

let t: TestNode;
afterEach(async () => { await t?.stop(); t = undefined as any; });

const lastText = (t: TestNode, id: string) =>
  t.feed(id).filter((i) => i.kind === 'text').map((i) => (i as any).text).at(-1);

describe('agent runtime', () => {
  it('runs multiple turns in a single long-lived process', async () => {
    t = await makeNode();
    const p = t.node.projects.create(t.project);
    const a = t.node.runtime.create({ projectId: p.id, name: 'alpha', task: 'hello' });
    await t.waitFor(() => lastText(t, a.id) === 'echo: hello');
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'idle');
    t.node.runtime.deliver(a.id, 'RECALL');
    await t.waitFor(() => lastText(t, a.id) === 'prior=1');
    assert.equal(t.spawns().filter((s) => s.args.includes('--input-format')).length, 1, 'one process for both turns');
    const agent = t.node.runtime.get(a.id);
    assert.equal(agent.id, a.id);
    assert.ok(agent.contextTokens > 0);
    assert.ok(agent.sessionTokens > 0);
  });

  it('queues messages during a turn and sends them combined at the boundary', async () => {
    t = await makeNode();
    const p = t.node.projects.create(t.project);
    const a = t.node.runtime.create({ projectId: p.id, task: 'SLOW one' });
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'working');
    t.node.runtime.deliver(a.id, 'two');
    t.node.runtime.deliver(a.id, 'three', 'backend-1');
    assert.equal(t.node.runtime.list().find((x) => x.id === a.id)!.queued, 2);
    await t.waitFor(() => lastText(t, a.id)?.includes('[from backend-1] three'));
    const text = lastText(t, a.id)!;
    assert.match(text, /^echo: two\n\n---\n\n\[from backend-1\] three$/);
    assert.equal(t.spawns().filter((s) => s.args.includes('--input-format')).length, 1);
  });

  it('pairs tool_use with tool_result in the feed', async () => {
    t = await makeNode();
    const p = t.node.projects.create(t.project);
    const a = t.node.runtime.create({ projectId: p.id, task: 'TOOL please' });
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'idle');
    const tool = t.feed(a.id).find((i) => i.kind === 'tool') as any;
    assert.equal(tool.tool, 'Bash');
    assert.equal(tool.summary, 'Say hi');
    assert.equal(tool.status, 'ok');
    assert.equal(tool.result, 'hi');
    assert.ok(t.events.some((e) => e.type === 'agent:text-delta'));
  });

  it('interrupts a turn via control_request and keeps the process alive', async () => {
    t = await makeNode();
    const p = t.node.projects.create(t.project);
    const a = t.node.runtime.create({ projectId: p.id, task: 'SLOW long job' });
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'working');
    t.node.runtime.interrupt(a.id);
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'idle');
    const turn = t.feed(a.id).find((i) => i.kind === 'turn') as any;
    assert.equal(turn.interrupted, true);
    assert.equal(turn.isError, false);
    t.node.runtime.deliver(a.id, 'after');
    await t.waitFor(() => lastText(t, a.id) === 'echo: after');
    assert.equal(t.spawns().filter((s) => s.args.includes('--input-format')).length, 1);
  });

  it('falls back to killing the process when an interrupt is ignored, then resumes', async () => {
    t = await makeNode({ interruptGraceMs: 200 });
    const p = t.node.projects.create(t.project);
    const a = t.node.runtime.create({ projectId: p.id, task: 'STUCK' });
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'working');
    t.node.runtime.interrupt(a.id);
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'asleep');
    t.node.runtime.deliver(a.id, 'RECALL');
    await t.waitFor(() => lastText(t, a.id) === 'prior=1');
    const spawns = t.spawns().filter((s) => s.args.includes('--input-format'));
    assert.equal(spawns.length, 2);
    assert.ok(spawns[1].args.includes('--resume'));
  });

  it('keeps identity and conversation across a node restart (process dies, session survives)', async () => {
    t = await makeNode();
    const p = t.node.projects.create(t.project);
    const a = t.node.runtime.create({ projectId: p.id, name: 'beta', task: 'first' });
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'idle');
    const sid = t.node.runtime.get(a.id).sessionId;

    await t.restart();
    const after = t.node.runtime.get(a.id);
    assert.equal(after.status, 'asleep');
    assert.equal(after.name, 'beta');
    assert.equal(after.sessionId, sid);

    t.node.runtime.deliver(a.id, 'RECALL');
    await t.waitFor(() => lastText(t, a.id) === 'prior=1');
    const spawns = t.spawns().filter((s) => s.args.includes('--input-format'));
    assert.deepEqual(spawns[1].args.slice(spawns[1].args.indexOf('--resume'), spawns[1].args.indexOf('--resume') + 2), ['--resume', sid]);
    assert.equal(t.node.runtime.get(a.id).sessionId, sid);
  });

  it('recovers from a crash mid-turn by resuming and re-priming', async () => {
    t = await makeNode();
    const p = t.node.projects.create(t.project);
    const a = t.node.runtime.create({ projectId: p.id, task: 'warmup' });
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'idle');
    t.node.runtime.deliver(a.id, 'CRASH now');
    await t.waitFor(() => lastText(t, a.id)?.startsWith('echo: [from axo] Your previous turn was cut off'));
    const sys = t.feed(a.id).find((i) => i.kind === 'system' && i.level === 'error') as any;
    assert.match(sys.text, /simulated crash/);
    assert.ok(t.spawns().filter((s) => s.args.includes('--input-format'))[1].args.includes('--resume'));
  });

  it('enters error state after repeated crashes instead of looping', async () => {
    t = await makeNode({ crashLimit: 2 });
    const p = t.node.projects.create(t.project);
    const a = t.node.runtime.create({ projectId: p.id, task: 'warmup' });
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'idle');
    t.node.runtime.deliver(a.id, 'CRASH');
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'asleep' || t.node.runtime.get(a.id).status === 'working');
    t.node.runtime.deliver(a.id, 'CRASH again');
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'error');
    assert.match(t.node.runtime.get(a.id).lastError!, /crashed 2 times/);
  });

  it('starts a fresh session if the old one cannot be resumed', async () => {
    t = await makeNode();
    const p = t.node.projects.create(t.project);
    const a = t.node.runtime.create({ projectId: p.id, task: 'first' });
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'idle');
    const sid = t.node.runtime.get(a.id).sessionId!;
    await t.restart();
    const { rmSync } = await import('node:fs');
    rmSync(`${t.fakeDir}/${sid}.json`);
    t.node.runtime.deliver(a.id, 'RECALL');
    await t.waitFor(() => lastText(t, a.id) === 'prior=0');
    assert.notEqual(t.node.runtime.get(a.id).sessionId, sid);
  });

  it('reaps idle processes and resumes transparently', async () => {
    t = await makeNode({}, { idleReapMs: 100 });
    const p = t.node.projects.create(t.project);
    const a = t.node.runtime.create({ projectId: p.id, task: 'one' });
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'asleep', 3000);
    t.node.runtime.deliver(a.id, 'RECALL');
    await t.waitFor(() => lastText(t, a.id) === 'prior=1');
    assert.equal(t.spawns().filter((s) => s.args.includes('--input-format')).length, 2);
  });

  it('passes identity env and strips inherited agent env', async () => {
    process.env.GROOVE_AGENT_ID = 'leak';
    t = await makeNode();
    const p = t.node.projects.create(t.project);
    const a = t.node.runtime.create({ projectId: p.id, task: 'x' });
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'idle');
    assert.equal(t.spawns().filter((s) => s.args.includes('--input-format'))[0].env.AXO_AGENT_ID, a.id);
    delete process.env.GROOVE_AGENT_ID;
  });

  it('rejects duplicate names and auto-names by role', async () => {
    t = await makeNode();
    const p = t.node.projects.create(t.project);
    const a1 = t.node.runtime.create({ projectId: p.id, role: 'backend' });
    const a2 = t.node.runtime.create({ projectId: p.id, role: 'backend' });
    assert.equal(a1.name, 'backend-1');
    assert.equal(a2.name, 'backend-2');
    assert.throws(() => t.node.runtime.create({ projectId: p.id, name: 'backend-1' }), /already exists/);
  });
});

describe('runtime hooks', () => {
  it('emits turn-end with the turn text and inputs', async () => {
    t = await makeNode();
    const p = t.node.projects.create(t.project);
    const events: any[] = [];
    t.node.runtime.on('turn-end', (e) => events.push(e));
    const a = t.node.runtime.create({ projectId: p.id, task: 'ping' });
    await t.waitFor(() => events.length === 1);
    assert.equal(events[0].agentId, a.id);
    assert.equal(events[0].lastText, 'echo: ping');
    assert.deepEqual(events[0].inputs, [{ text: 'ping', author: 'user' }]);
    assert.equal(events[0].interrupted, false);
  });
});

describe('settings changes', () => {
  it('applies model changes made mid-turn at the next turn boundary', async () => {
    t = await makeNode();
    const p = t.node.projects.create(t.project);
    const a = t.node.runtime.create({ projectId: p.id, task: 'SLOW work', model: 'sonnet' });
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'working');
    t.node.runtime.update(a.id, { model: 'haiku' });
    t.node.runtime.deliver(a.id, 'next');
    const agentSpawns = () => t.spawns().filter((s) => s.args.includes('--input-format'));
    await t.waitFor(() => agentSpawns().length === 2);
    const args = agentSpawns()[1].args;
    assert.equal(args[args.indexOf('--model') + 1], 'haiku');
    assert.ok(args.includes('--resume'));
    await t.waitFor(() => t.feed(a.id).some((i) => i.kind === 'text' && i.text === 'echo: next'));
  });
});

describe('environment hygiene', () => {
  it('never leaks ELECTRON_RUN_AS_NODE into agents', async () => {
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const { claudeEnv } = await import('../src/runtime/agent-runtime.ts');
      assert.equal(claudeEnv({ authMode: 'subscription' }).ELECTRON_RUN_AS_NODE, undefined);
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE;
    }
  });
});
