import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Agent, FeedItem } from '@axo/protocol';
import type { EventBus } from '../events.ts';
import { claudeEnv, type AgentRuntime, type TurnEndEvent } from '../runtime/agent-runtime.ts';
import type { Journalist } from '../journalist/journalist.ts';
import type { Headless } from '../journalist/headless.ts';
import type { NodeConfig } from '../config.ts';
import { ClaudeProcess } from '../runtime/claude-process.ts';
import { parseLine, ParseContext } from '../runtime/parser.ts';
import { gitSummary } from '../journalist/files.ts';
import { renderTranscript } from '../journalist/transcript.ts';
import { ulid } from '../util/ulid.ts';
import { HttpError } from '../util/http-error.ts';

export interface RotationConfig {
  contextPct: number;          // rotate when context ≥ this fraction of the window…
  minCompactions: number;      // …and Claude has already compacted at least this often
  tokenCeiling: number;        // fresh tokens per session
  velocityTokens: number;      // fresh tokens within velocityWindowMs
  velocityWindowMs: number;
  cooldownMs: number;          // between automatic rotations of one agent
  maxAutoPerHour: number;      // circuit breaker against rotation loops
  warmupTimeoutMs: number;
  verify: boolean;
}

export const DEFAULT_ROTATION: RotationConfig = {
  contextPct: 0.85,
  minCompactions: 2,
  tokenCeiling: 5_000_000,
  velocityTokens: 1_500_000,
  velocityWindowMs: 5 * 60_000,
  cooldownMs: 10 * 60_000,
  maxAutoPerHour: 3,
  warmupTimeoutMs: 5 * 60_000,
  verify: true,
};

export type RotationReason = 'manual' | 'context' | 'ceiling' | 'velocity' | 'degraded' | 'requested';
export type BriefMode = 'interview' | 'journalist';

interface ToolRec { tool: string; key: string; isError: boolean }
interface TurnRec { ts: number; fresh: number; textLen: number; isError: boolean; tools: ToolRec[] }

const WARMUP = `[axo] Context refresh. Before continuing, re-read whatever files you need based on your working state and handoff so you are fully caught up. Do not change anything yet. Then reply with exactly three lines:
TASK: <the current task>
NEXT: <the exact next action you will take>
OPEN: <open threads, or "none">`;

const INTERVIEW = `[axo] Your context is about to be refreshed and a fresh copy of you will continue this exact work. Write the handoff brief it needs, in markdown, with these sections: ## Where things stand, ## Exactly what to do next, ## Watch out for (pitfalls, failed approaches, gotchas), ## Context you will need (files, commands, decisions). Be concrete: paths, function names, commands, errors. Under 700 words. Output only the brief.`;

const VERIFY_SYSTEM = `You check whether an AI agent that just took over a task understood its handoff. Compare the agent's summary with the working-state document. Reply with exactly "PASS" if the task and next action are consistent with the document (wording may differ), otherwise "FAIL: <one-line reason>".`;

/**
 * Seamless context rotation. A fresh process is warmed up in the background
 * from the journalist's state doc plus a handoff brief, verified, and swapped
 * in at a turn boundary under the same agent identity and chat.
 */
export class Rotator {
  private readonly runtime: AgentRuntime;
  private readonly journalist: Journalist;
  private readonly headless: Headless;
  private readonly bus: EventBus;
  private readonly cfg: NodeConfig;
  readonly rc: RotationConfig;
  private readonly history = new Map<string, TurnRec[]>();
  private readonly rotating = new Set<string>();
  private readonly autoLog = new Map<string, number[]>();
  private readonly lastRotation = new Map<string, number>();
  private readonly onTurn = (e: TurnEndEvent) => this.onTurnEnd(e);

  constructor(runtime: AgentRuntime, journalist: Journalist, headless: Headless, bus: EventBus, cfg: NodeConfig, rc: Partial<RotationConfig> = {}) {
    this.runtime = runtime;
    this.journalist = journalist;
    this.headless = headless;
    this.bus = bus;
    this.cfg = cfg;
    this.rc = { ...DEFAULT_ROTATION, ...rc };
  }

  start(): void { this.runtime.on('turn-end', this.onTurn); }
  stop(): void { this.runtime.off('turn-end', this.onTurn); }
  isRotating(id: string): boolean { return this.rotating.has(id); }

  // ── triggers ────────────────────────────────────────────

  private onTurnEnd(e: TurnEndEvent): void {
    if (this.rotating.has(e.agentId)) return;
    const tools: ToolRec[] = this.runtime.feedSince(e.agentId, e.startedAt - 1, 300)
      .filter((i): i is Extract<FeedItem, { kind: 'tool' }> => i.kind === 'tool')
      .map((t) => ({ tool: t.tool, key: `${t.tool}:${JSON.stringify(t.input).slice(0, 400)}`, isError: t.status === 'error' }));
    const recs = this.history.get(e.agentId) ?? [];
    recs.push({ ts: Date.now(), fresh: e.freshTokens, textLen: e.text.length, isError: e.isError, tools });
    if (recs.length > 60) recs.splice(0, recs.length - 60);
    this.history.set(e.agentId, recs);

    const reason = this.check(e.agentId);
    if (reason) {
      const mode: BriefMode = reason === 'context' || reason === 'ceiling' ? 'interview' : 'journalist';
      void this.rotate(e.agentId, { reason, mode, auto: true }).catch(() => { /* reported via events */ });
    }
  }

  /** Which trigger (if any) fires for this agent right now. */
  check(id: string): RotationReason | null {
    let a: Agent;
    try { a = this.runtime.get(id); } catch { return null; }
    const rc = this.rc;
    if (a.contextWindow && a.contextTokens / a.contextWindow >= rc.contextPct && a.compactions >= rc.minCompactions) return 'context';
    if (a.sessionTokens >= rc.tokenCeiling) return 'ceiling';
    const recs = this.history.get(id) ?? [];
    const since = Date.now() - rc.velocityWindowMs;
    if (recs.filter((r) => r.ts >= since).reduce((n, r) => n + r.fresh, 0) >= rc.velocityTokens) return 'velocity';
    if (degradationSignals(recs).length >= 2) return 'degraded';
    return null;
  }

  signals(id: string): string[] { return degradationSignals(this.history.get(id) ?? []); }

  // ── rotation ────────────────────────────────────────────

  async rotate(id: string, opts: { reason: RotationReason; mode?: BriefMode; note?: string; auto?: boolean }): Promise<void> {
    const a0 = this.runtime.get(id);
    if (this.rotating.has(id)) throw new HttpError(409, 'a refresh is already in progress');
    if (opts.auto) {
      const now = Date.now();
      if (now - (this.lastRotation.get(id) ?? 0) < this.rc.cooldownMs) return;
      const log = (this.autoLog.get(id) ?? []).filter((t) => now - t < 3600_000);
      if (log.length >= this.rc.maxAutoPerHour) {
        if (log.length === this.rc.maxAutoPerHour) {
          this.runtime.postFeed(id, sys('warn', `Automatic context refresh paused: ${log.length} refreshes in the last hour. Use Refresh manually if needed.`));
          log.push(now);
          this.autoLog.set(id, log);
        }
        return;
      }
      log.push(now);
      this.autoLog.set(id, log);
    }

    this.rotating.add(id);
    const mode: BriefMode = opts.mode ?? (opts.reason === 'manual' ? 'journalist' : 'interview');
    this.bus.publish({ type: 'rotation:started', agentId: id, reason: opts.reason });
    let shadow: ClaudeProcess | null = null;
    let held = false;
    try {
      // 1. Working state fully up to date.
      await this.journalist.flush(id);

      // 2. Handoff brief: the agent's own account if it is healthy, else the journalist's.
      let brief = '';
      if (mode === 'interview') brief = await this.interview(a0).catch(() => '');
      if (!brief) brief = await this.journalist.handoffBrief(a0, { note: opts.note });

      // 3+4. Warm up a fresh session in the background; verify it understood.
      let attempt = await this.warmup(a0, brief, opts.note);
      shadow = attempt.proc;
      if (this.rc.verify) {
        let verdict = await this.verify(a0, attempt.reply);
        if (!verdict.ok) {
          shadow.kill('SIGTERM');
          const fuller = await this.journalist.handoffBrief(a0, { note: opts.note, transcriptChars: 60_000 });
          attempt = await this.warmup(a0, `${brief}\n\n---\n\n${fuller}`, opts.note);
          shadow = attempt.proc;
          verdict = await this.verify(a0, attempt.reply);
          if (!verdict.ok) throw new Error(`replacement did not pick up the task (${verdict.reason})`);
        }
      }

      // 5. Swap at a turn boundary. Anything that happened during warm-up is replayed first.
      await this.runtime.whenIdle(id);
      this.runtime.hold(id);
      held = true;
      const missed = this.runtime.feedSince(id, attempt.snapshotTs, 200)
        .filter((i) => i.kind === 'user' || i.kind === 'text' || i.kind === 'tool');
      let stats = attempt.stats;
      if (missed.length) {
        const r = await runTurn(shadow, `[axo] While you were catching up, this happened in your session:\n\n${renderTranscript(missed, 20_000)}\n\nAbsorb it and reply "OK".`, this.rc.warmupTimeoutMs, attempt.ctx);
        stats = { contextTokens: r.contextTokens || stats.contextTokens, sessionTokens: stats.sessionTokens + r.freshTokens };
      }
      if (!shadow.alive) throw new Error('replacement process exited during warm-up');

      const gen = this.runtime.get(id).generation + 1;
      this.runtime.adopt(id, shadow, attempt.sessionId, stats);
      shadow = null;
      this.journalist.saveHandoff(this.runtime.get(id), gen, `# Handoff — generation ${gen}\n\nReason: ${opts.reason}${opts.note ? ` — "${opts.note}"` : ''}\nBrief by: ${mode}\n\n${brief}`);
      this.runtime.postFeed(id, { kind: 'rotation', id: `r-${ulid()}`, ts: Date.now(), generation: gen, reason: opts.reason, note: opts.note ?? null });
      this.runtime.release(id);
      held = false;
      this.lastRotation.set(id, Date.now());
      this.history.delete(id);
      this.bus.publish({ type: 'rotation:completed', agentId: id, generation: gen });
    } catch (e: any) {
      shadow?.kill('SIGTERM');
      if (held) this.runtime.release(id);
      const reason = e?.message ?? String(e);
      try { this.runtime.postFeed(id, sys('warn', `Context refresh aborted: ${reason}. The agent continues in its current session.`)); } catch { /* agent deleted */ }
      this.bus.publish({ type: 'rotation:aborted', agentId: id, reason });
      throw e;
    } finally {
      this.rotating.delete(id);
    }
  }

  /** New agent in the same team seeded with this agent's working state. */
  fork(id: string, req: { name?: string; task?: string }): Agent {
    const src = this.runtime.get(id);
    const state = this.journalist.readState(src).text;
    const agent = this.runtime.create({ projectId: src.projectId, teamId: src.teamId, role: src.role, model: src.model, effort: src.effort ?? undefined, name: req.name, instructions: src.instructions });
    if (state.trim()) this.journalist.writeStateManual(agent, `> Forked from ${src.name}. This is their working state at the time of the fork; it is now yours.\n\n${state}`);
    this.runtime.deliver(agent.id, req.task?.trim() || `You were forked from ${src.name}. Review your working state, then continue the work described there.`);
    return agent;
  }

  /** Ask a forked copy of the agent's own session to write its handoff. The live session is untouched. */
  private interview(a: Agent): Promise<string> {
    if (!a.sessionId) return Promise.resolve('');
    const env = claudeEnv(this.cfg);
    const args = ['-p', '--output-format', 'json', '--resume', a.sessionId, '--fork-session', '--no-session-persistence', '--model', a.model, '--tools', ''];
    return new Promise((resolve, reject) => {
      const child = spawn(this.cfg.claudeBin, args, { cwd: a.workdir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('interview timed out')); }, 180_000);
      child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const j = JSON.parse(out);
          const text = String(j.result ?? '').trim();
          if (j.is_error || text.length < 200) return reject(new Error('interview produced no usable brief'));
          resolve(text);
        } catch { reject(new Error('interview failed')); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(INTERVIEW);
    });
  }

  private async warmup(a: Agent, brief: string, note?: string) {
    const snapshotTs = Date.now();
    const handoff = [
      brief.trim(),
      note ? `\n**Note from the user about this refresh:** ${note}` : '',
      '\n### Most recent conversation (verbatim)\n',
      this.journalist.recentExchanges(a, 6) || '(none)',
      '\n### Repository state\n',
      '```\n' + (gitSummary(a.workdir) || 'not a git repository') + '\n```',
    ].join('\n');
    const sessionId = randomUUID();
    const spec = this.runtime.buildSpawnSpec(a, { sessionId, resume: false, extraPrompt: handoff });
    if (!spec) throw new Error('project or team missing');
    const proc = new ClaudeProcess(spec);
    const ctx = new ParseContext(a.workdir);
    proc.start();
    try {
      const r = await runTurn(proc, WARMUP, this.rc.warmupTimeoutMs, ctx);
      if (r.isError) throw new Error('warm-up turn failed');
      return { proc, ctx, sessionId, snapshotTs, reply: r.text, stats: { contextTokens: r.contextTokens, sessionTokens: r.freshTokens } };
    } catch (e) {
      proc.kill('SIGTERM');
      throw e;
    }
  }

  private async verify(a: Agent, reply: string): Promise<{ ok: boolean; reason: string }> {
    if (!/TASK:/i.test(reply) || !/NEXT:/i.test(reply)) return { ok: false, reason: 'no TASK/NEXT summary' };
    const state = this.journalist.readState(a).text;
    if (!state.trim()) return { ok: true, reason: 'no state doc to compare' };
    try {
      const { text } = await this.headless.run({
        system: VERIFY_SYSTEM,
        prompt: `# Working-state document\n${state}\n\n# The agent's summary after taking over\n${reply}`,
      });
      const t = text.trim();
      return /^PASS\b/i.test(t) ? { ok: true, reason: '' } : { ok: false, reason: t.replace(/^FAIL:?\s*/i, '').slice(0, 200) || 'mismatch' };
    } catch (e: any) {
      return { ok: true, reason: `verifier unavailable: ${e?.message}` }; // don't block on verifier outages
    }
  }
}

// ── helpers ─────────────────────────────────────────────────

/** Send one turn to a standalone process and collect the result. */
function runTurn(proc: ClaudeProcess, text: string, timeoutMs: number, ctx: ParseContext) {
  return new Promise<{ text: string; isError: boolean; contextTokens: number; freshTokens: number }>((resolve, reject) => {
    const texts: string[] = [];
    let contextTokens = 0;
    const onLine = (line: string) => {
      for (const act of parseLine(line, ctx)) {
        if (act.type === 'feed' && act.item.kind === 'text') texts.push(act.item.text);
        if (act.type === 'context') contextTokens = act.tokens;
        if (act.type === 'turn-end') {
          cleanup();
          const u = act.usage;
          resolve({ text: texts.join('\n\n'), isError: act.isError, contextTokens, freshTokens: u.input + u.output + u.cacheCreation });
        }
      }
    };
    const onExit = () => { cleanup(); reject(new Error('replacement process exited')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('warm-up timed out')); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); proc.off('line', onLine); proc.off('exit', onExit); };
    proc.on('line', onLine);
    proc.on('exit', onExit);
    if (!proc.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })) { cleanup(); reject(new Error('replacement process not writable')); }
  });
}

/** Independent degradation signals (never count the same root cause twice). */
export function degradationSignals(recs: TurnRec[]): string[] {
  const out: string[] = [];
  const tools = recs.flatMap((r) => r.tools);
  const last15 = tools.slice(-15);
  const counts = new Map<string, number>();
  for (const t of last15) counts.set(t.key, (counts.get(t.key) ?? 0) + 1);
  if ([...counts.values()].some((n) => n >= 4)) out.push('loop');

  const edits = tools.filter((t) => ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(t.tool)).slice(-4);
  if (edits.length === 4 && edits.every((t) => t.isError)) out.push('edit-failures');

  const withText = recs.filter((r) => r.textLen > 0);
  if (withText.length >= 8) {
    const base = median(withText.slice(0, 5).map((r) => r.textLen));
    const tail = recs.slice(-3);
    if (base > 200 && tail.length === 3 && tail.every((r) => r.textLen < base * 0.15)) out.push('output-collapse');
  }

  const lastTwo = recs.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every((r) => r.isError)) out.push('truncation');
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function sys(level: 'info' | 'warn' | 'error', text: string): FeedItem {
  return { kind: 'system', id: `s-${ulid()}`, ts: Date.now(), level, text };
}
