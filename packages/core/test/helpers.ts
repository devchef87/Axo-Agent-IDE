import { mkdtempSync, mkdirSync, chmodSync, readFileSync, existsSync } from 'node:fs';
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
  spawns(): { args: string[]; pid: number; env: Record<string, string> }[];
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

  const mk = () => new Node({ home, port: 0, claudeBin: FAKE_CLAUDE, idleReapMs: 60_000, ...extra }, opts, undefined, { journalist: { debounceMs: 60_000, ...nodeExtra?.journalist }, rotation: nodeExtra?.rotation });
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
