import { mkdtempSync, mkdirSync, chmodSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope, FeedItem } from '@axo/protocol';
import { Node } from '../src/node.ts';
import type { RuntimeOptions } from '../src/runtime/agent-runtime.ts';

export const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
chmodSync(FAKE_CLAUDE, 0o755);

export interface TestNode {
  node: Node;
  home: string;
  project: string;
  fakeDir: string;
  events: EventEnvelope[];
  spawns(): { args: string[]; pid: number; cwd: string; env: Record<string, string> }[];
  feed(agentId: string): FeedItem[];
  waitFor<T>(fn: () => T | undefined | false, timeoutMs?: number): Promise<T>;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export async function makeNode(opts: RuntimeOptions = {}, extra: Record<string, unknown> = {}, nodeExtra: ConstructorParameters<typeof Node>[3] = {}): Promise<TestNode> {
  const root = mkdtempSync(join(tmpdir(), 'axo-test-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const fakeDir = join(root, 'fake');
  mkdirSync(project, { recursive: true });
  mkdirSync(fakeDir, { recursive: true });
  process.env.FAKE_CLAUDE_DIR = fakeDir;

  const mk = () => new Node({ home, port: 0, claudeBin: FAKE_CLAUDE, idleReapMs: 60_000, ...extra }, opts, undefined, {
    journalist: { debounceMs: 60_000, ...nodeExtra?.journalist }, rotation: nodeExtra?.rotation,
    watches: { minPollMs: 50, commandPollMs: 50 },
  });
  const t: TestNode = {
    node: mk(),
    home, project, fakeDir,
    events: [],
    spawns() {
      const f = join(fakeDir, 'spawns.log');
      return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    },
    feed(agentId) { return t.node.store.feedPage(agentId, null, 1000).items; },
    async waitFor(fn, timeoutMs = 5000) {
      const start = Date.now();
      for (;;) {
        const v = fn();
        if (v) return v as any;
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    async restart() {
      await t.node.stop();
      t.node = mk();
      t.node.bus.on('event', (e: EventEnvelope) => t.events.push(e));
      await t.node.start();
    },
    async stop() { await t.node.stop(); },
  };
  t.node.bus.on('event', (e: EventEnvelope) => t.events.push(e));
  await t.node.start();
  return t;
}

/** Make `dir` a git repo with one commit on `main`. */
export function initRepo(dir: string): void {
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@axo.dev');
  run('config', 'user.name', 'axo test');
  writeFileSync(join(dir, 'README.md'), '# test\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  run('add', '.');
  run('commit', '-q', '-m', 'init');
}

/** REST call against the test node (node token by default). */
export async function call(t: TestNode, path: string, init: RequestInit = {}, token = t.node.cfg.token): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${t.node.cfg.port}/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, body };
}
