import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeNode, type TestNode } from './helpers.ts';
import { degradationSignals } from '../src/rotation/rotator.ts';

let t: TestNode;
afterEach(async () => { await t?.stop(); t = undefined as any; });
const agentSpawns = (t: TestNode) => t.spawns().filter((s) => s.args.includes('--input-format'));

const STATE = '## Mission\nBuild the widget\n## Plan\n1. [x] scaffold\n2. [ ] tests\n## Now\nWriting tests next\n## Decisions\n- use vitest\n## Files\n- src/widget.ts\n## Open threads\nnone\n## User instructions\nkeep it small';
const HANDOFF = '## Where things stand\nScaffold done.\n## Exactly what to do next\nWrite tests.\n## Watch out for\nnothing\n## Context you will need\nsrc/widget.ts';

function rules(t: TestNode, list: { match: string; reply: string }[]) {
  writeFileSync(join(t.fakeDir, 'headless.json'), JSON.stringify(list));
}
const standard = (verify = 'PASS') => [
  { match: 'working-state document for an AI coding agent', reply: STATE },
  { match: 'You write handoff briefs', reply: HANDOFF },
  { match: 'Your context is about to be refreshed', reply: HANDOFF + '\n' + 'detail '.repeat(40) },
  { match: 'understood its handoff', reply: verify },
  { match: '=== MAP ===', reply: '=== MAP ===\nThe project has a widget in src/widget.ts and tests to come.\n=== NEW DECISIONS ===\n- use vitest — fast' },
];

async function idleAgent(t: TestNode, task = 'build the widget') {
  const p = t.node.projects.create(t.project);
  const a = t.node.runtime.create({ projectId: p.id, name: 'w', task });
  await t.waitFor(() => t.node.runtime.get(a.id).status === 'idle');
  return { p, a };
}

describe('journalist', () => {
  it('writes the state doc after a turn and injects it into the next spawn', async () => {
    t = await makeNode({}, {}, { journalist: { debounceMs: 30 } });
    rules(t, standard());
    const { p, a } = await idleAgent(t);
    const statePath = join(t.project, '.axo', 'state', 'w.md');
    await t.waitFor(() => existsSync(statePath));
    assert.match(readFileSync(statePath, 'utf8'), /^<!-- axo:cursor=\d+ -->\n## Mission\nBuild the widget/);
    assert.equal(t.node.journalist.readState(t.node.runtime.get(a.id)).text.includes('Writing tests next'), true);

    // The prompt sent to the journalist contained the transcript.
    const log = readFileSync(join(t.fakeDir, 'headless.log'), 'utf8');
    assert.match(log, /USER: build the widget/);

    // Restart → resumed process gets the state doc in its system prompt.
    await t.restart();
    t.node.runtime.deliver(a.id, 'next');
    await t.waitFor(() => agentSpawns(t).length === 2);
    const args = agentSpawns(t)[1].args;
    assert.match(args[args.indexOf('--append-system-prompt') + 1], /Your working state[\s\S]*Writing tests next/);
    assert.ok(p);
  });

  it('rejects malformed state docs instead of overwriting', async () => {
    t = await makeNode({}, {}, { journalist: { debounceMs: 30 } });
    rules(t, [{ match: 'working-state document', reply: 'garbage' }]);
    await idleAgent(t);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(existsSync(join(t.project, '.axo', 'state', 'w.md')), false);
  });

  it('excludes .axo from git without touching .gitignore, and refreshes the map', async () => {
    t = await makeNode({}, {}, { journalist: { debounceMs: 30 } });
    execFileSync('git', ['init', '-q'], { cwd: t.project });
    rules(t, standard());
    const { p } = await idleAgent(t);
    await t.waitFor(() => existsSync(join(t.project, '.axo', 'state', 'w.md')));
    assert.match(readFileSync(join(t.project, '.git', 'info', 'exclude'), 'utf8'), /^\.axo\/$/m);
    assert.equal(existsSync(join(t.project, '.gitignore')), false);
    const ctx = await t.node.journalist.refreshMaps(true).then(() => t.node.journalist.projectContext(t.node.store.getProject(p.id)!));
    assert.match(ctx.map, /widget in src\/widget.ts/);
    assert.match(ctx.decisions, /- use vitest — fast/);
  });
});

describe('rotation', () => {
  it('manual refresh swaps in a verified fresh session under the same identity', async () => {
    t = await makeNode({}, {}, { journalist: { debounceMs: 30 } });
    rules(t, standard());
    const { a } = await idleAgent(t);
    const before = { ...t.node.runtime.get(a.id) };
    await t.node.rotator.rotate(a.id, { reason: 'manual', note: 'it was looping' });

    const after = t.node.runtime.get(a.id);
    assert.equal(after.id, before.id);
    assert.equal(after.name, 'w');
    assert.equal(after.generation, 1);
    assert.notEqual(after.sessionId, before.sessionId);
    const warm = agentSpawns(t).at(-1)!.args;
    const prompt = warm[warm.indexOf('--append-system-prompt') + 1];
    assert.match(prompt, /## Handoff[\s\S]*Write tests\.[\s\S]*it was looping/);
    assert.match(prompt, /Most recent conversation[\s\S]*build the widget/);
    assert.ok(t.feed(a.id).some((i) => i.kind === 'rotation'));
    assert.ok(existsSync(join(t.project, '.axo', 'handoffs', 'w', '0001.md')));

    // Next message goes to the adopted process (warm-up was its first turn).
    t.node.runtime.deliver(a.id, 'RECALL');
    await t.waitFor(() => t.feed(a.id).some((i) => i.kind === 'text' && i.text === 'prior=1'));
    assert.ok(t.events.some((e) => e.type === 'rotation:completed'));
  });

  it('aborts and keeps the current session when verification fails twice', async () => {
    t = await makeNode({}, {}, { journalist: { debounceMs: 30 } });
    rules(t, standard('FAIL: wrong task'));
    const { a } = await idleAgent(t);
    const sid = t.node.runtime.get(a.id).sessionId;
    await assert.rejects(t.node.rotator.rotate(a.id, { reason: 'manual' }), /did not pick up the task/);
    assert.equal(t.node.runtime.get(a.id).sessionId, sid);
    assert.equal(t.node.runtime.get(a.id).generation, 0);
    assert.ok(t.feed(a.id).some((i) => i.kind === 'system' && /refresh aborted/.test(i.text)));
    t.node.runtime.deliver(a.id, 'RECALL');
    await t.waitFor(() => t.feed(a.id).some((i) => i.kind === 'text' && i.text === 'prior=1'));
  });

  it('auto-rotates on the token ceiling using an interview of a forked session', async () => {
    t = await makeNode({}, {}, { journalist: { debounceMs: 30 }, rotation: { tokenCeiling: 1 } });
    rules(t, standard());
    const { a } = await idleAgent(t);
    await t.waitFor(() => t.events.some((e) => e.type === 'rotation:completed'), 8000);
    const log = readFileSync(join(t.fakeDir, 'headless.log'), 'utf8');
    assert.match(log, /Your context is about to be refreshed/);
    const interview = t.spawns().find((s) => s.args.includes('--fork-session'));
    assert.ok(interview, 'interview used --fork-session');
    assert.ok(t.events.some((e) => e.type === 'rotation:started' && e.reason === 'ceiling'));
    assert.equal(t.node.runtime.get(a.id).generation, 1);
  });

  it('fork creates a new agent seeded with the working state', async () => {
    t = await makeNode({}, {}, { journalist: { debounceMs: 30 } });
    rules(t, standard());
    const { a } = await idleAgent(t);
    await t.waitFor(() => existsSync(join(t.project, '.axo', 'state', 'w.md')));
    const f = t.node.rotator.fork(a.id, { name: 'w2' });
    assert.equal(f.teamId, t.node.runtime.get(a.id).teamId);
    const st = readFileSync(join(t.project, '.axo', 'state', 'w2.md'), 'utf8');
    assert.match(st, /Forked from w[\s\S]*Build the widget/);
    await t.waitFor(() => t.node.runtime.get(f.id).status === 'idle');
    assert.ok(readdirSync(join(t.project, '.axo', 'state')).includes('w2.md'));
  });
});

describe('degradation signals', () => {
  const turn = (over: Partial<{ fresh: number; textLen: number; isError: boolean; tools: any[] }> = {}) =>
    ({ ts: Date.now(), fresh: 10, textLen: 800, isError: false, tools: [], ...over });

  it('flags loops, edit failures, collapse and truncation independently', () => {
    const loop = Array.from({ length: 4 }, () => ({ tool: 'Bash', key: 'Bash:{"command":"npm test"}', isError: false }));
    assert.deepEqual(degradationSignals([turn({ tools: loop })]), ['loop']);

    const edits = Array.from({ length: 4 }, (_, i) => ({ tool: 'Edit', key: `Edit:${i}`, isError: true }));
    assert.deepEqual(degradationSignals([turn({ tools: edits })]), ['edit-failures']);

    const collapse = [...Array.from({ length: 6 }, () => turn()), turn({ textLen: 20 }), turn({ textLen: 10 }), turn({ textLen: 5 })];
    assert.deepEqual(degradationSignals(collapse), ['output-collapse']);

    assert.deepEqual(degradationSignals([turn({ isError: true }), turn({ isError: true })]), ['truncation']);
  });

  it('does not count failing tests (Bash errors) as degradation', () => {
    const tests = Array.from({ length: 6 }, (_, i) => ({ tool: 'Bash', key: `Bash:${i}`, isError: true }));
    assert.deepEqual(degradationSignals([turn({ tools: tests })]), []);
  });
});
