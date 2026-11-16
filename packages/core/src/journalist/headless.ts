import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeConfig } from '../config.ts';
import { claudeEnv } from '../runtime/agent-runtime.ts';

export interface HeadlessResult { text: string; costUsd: number }

/**
 * One-shot `claude -p` call for journalist work: no tools, no MCP, no session
 * saved, our own (tiny) system prompt, run from an empty dir so no project
 * CLAUDE.md loads. ~10x cheaper than the default Claude Code system prompt.
 * Calls are serialized through a small concurrency pool.
 */
export class Headless {
  private readonly cfg: NodeConfig;
  private readonly cwd: string;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly maxConcurrent: number;
  spentToday = 0;
  private day = new Date().toDateString();

  constructor(cfg: NodeConfig, maxConcurrent = 2) {
    this.cfg = cfg;
    this.maxConcurrent = maxConcurrent;
    this.cwd = join(cfg.home, 'tmp', 'headless');
    mkdirSync(this.cwd, { recursive: true });
  }

  async run(opts: { system: string; prompt: string; model?: string; timeoutMs?: number }): Promise<HeadlessResult> {
    await this.acquire();
    try {
      const res = await this.exec(opts);
      this.track(res.costUsd);
      return res;
    } finally {
      this.releaseSlot();
    }
  }

  private track(cost: number): void {
    const today = new Date().toDateString();
    if (today !== this.day) { this.day = today; this.spentToday = 0; }
    this.spentToday += cost;
  }

  private exec({ system, prompt, model = 'haiku', timeoutMs = 120_000 }: { system: string; prompt: string; model?: string; timeoutMs?: number }): Promise<HeadlessResult> {
    const env = claudeEnv(this.cfg);
    const args = [
      '-p', '--output-format', 'json', '--model', model,
      '--no-session-persistence', '--tools', '', '--strict-mcp-config',
      '--system-prompt', system,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.cfg.claudeBin, args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('headless call timed out')); }, timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
      child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          const j = JSON.parse(out);
          if (j.is_error) return reject(new Error(`headless error: ${String(j.result ?? '').slice(0, 300)}`));
          resolve({ text: String(j.result ?? ''), costUsd: Number(j.total_cost_usd ?? 0) });
        } catch {
          reject(new Error(`headless call failed (exit ${code}): ${err.slice(-400) || out.slice(-400)}`));
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) { this.active++; return Promise.resolve(); }
    return new Promise((res) => this.waiting.push(() => { this.active++; res(); }));
  }
  private releaseSlot(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}
