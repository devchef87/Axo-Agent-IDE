// Manual end-to-end check against the REAL claude CLI (model haiku). Not part of `npm test`: it
// spends tokens and takes a few minutes. Run from the repo root:
//   node --disable-warning=ExperimentalWarning packages/core/scripts/e2e-real.ts
// Starts a throwaway node (temp home, random port), creates a git project with a worktree team
// and two scoped agents, then checks: (a) knock denies a write into a teammate's scope,
// (b) `axo ask` gets the teammate's answer, (c) `axo watch` wakes the agent with the output.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope, FeedItem } from '@axo/protocol';
import { Node } from '../src/node.ts';

const STEP_MS = 4 * 60_000;
const root = mkdtempSync(join(tmpdir(), 'axo-e2e-'));
const project = join(root, 'project');
mkdirSync(join(project, 'src', 'api'), { recursive: true });
mkdirSync(join(project, 'src', 'ui'), { recursive: true });
writeFileSync(join(project, 'src', 'api', 'routes.ts'), 'export const routes = [];\n');
writeFileSync(join(project, 'src', 'ui', 'App.tsx'), 'export const App = () => null;\n');
const git = (...a: string[]) => execFileSync('git', a, { cwd: project, stdio: 'ignore' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'e2e@axo.dev');
git('config', 'user.name', 'axo e2e');
git('add', '.');
git('commit', '-q', '-m', 'init');

const node = new Node({ home: join(root, 'home'), port: 0, claudeBin: process.env.AXO_CLAUDE_BIN || 'claude', idleReapMs: 30 * 60_000 });
const events: EventEnvelope[] = [];
node.bus.on('event', (e: EventEnvelope) => events.push(e));
await node.start();
console.log(`[e2e] node on :${node.cfg.port}, home ${node.cfg.home}`);

const p = node.projects.create(project);
const team = node.teams.create({ projectId: p.id, name: 'e2e' });
const bob = node.runtime.create({ projectId: p.id, teamId: team.id, name: 'bob', role: 'backend', model: 'haiku' });
node.runtime.update(bob.id, { scopeGlobs: ['src/api/**'] });
const alice = node.runtime.create({ projectId: p.id, teamId: team.id, name: 'alice', role: 'frontend', model: 'haiku' });
node.runtime.update(alice.id, { scopeGlobs: ['src/ui/**'] });

const feed = (id: string): FeedItem[] => node.store.feedPage(id, null, 1000).items;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | undefined | false | null, ms = STEP_MS): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}
/** Deliver and wait for the agent to go idle with nothing queued; returns the feed items added. */
async function turn(id: string, text: string): Promise<FeedItem[]> {
  const before = new Set(feed(id).map((i) => i.id));
  node.runtime.deliver(id, text, 'user');
  await until('turn start', () => node.runtime.get(id).status !== 'idle' || feed(id).some((i) => i.kind === 'turn' && !before.has(i.id)));
  await until('turn end', () => {
    const a = node.runtime.list().find((x) => x.id === id)!;
    return a.status === 'idle' && a.queued === 0 && feed(id).some((i) => i.kind === 'turn' && !before.has(i.id));
  });
  return feed(id).filter((i) => !before.has(i.id));
}
const texts = (items: FeedItem[]) => items.filter((i) => i.kind === 'text').map((i) => (i as any).text as string);
const tools = (items: FeedItem[]) => items.filter((i) => i.kind === 'tool') as Extract<FeedItem, { kind: 'tool' }>[];

const results: Record<string, { pass: boolean; detail: string }> = {};
try {
  // (a) knock: alice writes into bob's scope
  {
    const items = await turn(alice.id, 'Use the Write tool to create the file src/api/hack.ts with the content `export const x = 1;`. '
      + 'Try exactly once. If the write is blocked, quote the exact error message you got and stop; do not try any workaround.');
    const writes = tools(items).filter((t) => /Write|Edit/.test(t.tool));
    const denied = events.find((e) => e.type === 'knock:denied' && e.agentId === alice.id) as any;
    const fileExists = existsSync(join(team.worktreePath!, 'src', 'api', 'hack.ts'));
    results.knock = {
      pass: !!denied && !fileExists && writes.some((w) => w.status === 'error' && /(owned by|belongs to) bob/.test(w.result ?? '')),
      detail: JSON.stringify({ toolResults: writes.map((w) => ({ tool: w.tool, status: w.status, result: w.result })), denied: denied?.reason, fileExists, aliceSaid: texts(items).at(-1) }, null, 2),
    };
    console.log('[e2e] (a) knock', results.knock.pass ? 'PASS' : 'FAIL', '\n', results.knock.detail);
  }

  // (b) axo ask
  {
    const items = await turn(alice.id, 'Run this exact command with the Bash tool: axo ask bob "What is 17 + 25? Reply with just the number."  '
      + 'Then tell me in one line what bob answered.');
    const bash = tools(items).filter((t) => t.tool === 'Bash');
    const answer = node.innerchat.threads(alice.id).flatMap((th) => node.innerchat.turns(th.id)).find((x) => x.kind === 'answer' && x.fromName === 'bob');
    results.ask = {
      pass: !!answer && /42/.test(answer.text) && texts(items).some((t) => /42/.test(t)),
      detail: JSON.stringify({ bash: bash.map((b) => ({ input: b.input.command, status: b.status, result: b.result })), bobAnswer: answer?.text, aliceSaid: texts(items).at(-1) }, null, 2),
    };
    console.log('[e2e] (b) ask', results.ask.pass ? 'PASS' : 'FAIL', '\n', results.ask.detail);
  }

  // (c) axo watch
  {
    const items = await turn(alice.id, 'Run this exact command with the Bash tool: axo watch "sleep 5 && echo done-e2e" --label e2e-sleep  '
      + 'Then end your turn right away. When the watch notification arrives, reply with the output it reported.');
    const bash = tools(items).filter((t) => t.tool === 'Bash');
    const w = await until('watch delivered', () => node.watches.list({ agentId: alice.id }).find((x) => x.status === 'delivered'), 60_000);
    const wake = await until('watch message', () => feed(alice.id).find((i) => i.kind === 'user' && i.author === 'watch') as any, 30_000);
    await until('woken turn end', () => {
      const a = node.runtime.list().find((x) => x.id === alice.id)!;
      return a.status === 'idle' && a.queued === 0 && feed(alice.id).some((i) => i.kind === 'turn' && i.ts > wake.ts);
    });
    const after = texts(feed(alice.id).filter((i) => i.ts > wake.ts));
    results.watch = {
      pass: w.result?.exitCode === 0 && /done-e2e/.test(wake.text) && after.some((t) => /done-e2e/.test(t)),
      detail: JSON.stringify({ bash: bash.map((b) => ({ input: b.input.command, result: b.result })), watch: { label: w.label, result: w.result }, aliceAfterWake: after.at(-1) }, null, 2),
    };
    console.log('[e2e] (c) watch', results.watch.pass ? 'PASS' : 'FAIL', '\n', results.watch.detail);
  }
} catch (e) {
  console.error('[e2e] error:', e);
  results.error = { pass: false, detail: String(e) };
} finally {
  await node.stop();
  console.log('\n[e2e] summary:', Object.entries(results).map(([k, v]) => `${k}=${v.pass ? 'PASS' : 'FAIL'}`).join(' '));
  console.log(`[e2e] scratch dir kept for inspection: ${root}`);
  process.exit(Object.values(results).every((r) => r.pass) ? 0 : 1);
}
