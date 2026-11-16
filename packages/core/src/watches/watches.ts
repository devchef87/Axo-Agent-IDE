import { spawn } from 'node:child_process';
import {
  closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, truncateSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CreateWatchReq, Watch, WatchMode, WatchResult, WatchStatus } from '@axo/protocol';
import type { Store } from '../store/db.ts';
import type { EventBus } from '../events.ts';
import type { AgentRuntime } from '../runtime/agent-runtime.ts';
import { ulid } from '../util/ulid.ts';
import { HttpError } from '../util/http-error.ts';
import { shq } from '../teams/bin.ts';

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_POLL_MS = 15_000;
const MAX_ACTIVE_PER_AGENT = 5;
const OUTPUT_TAIL = 4096;
const KEEP_LOG_BYTES = 64 * 1024;          // a finished job's out.log is trimmed to this
const HISTORY_MS = 7 * 24 * 60 * 60_000;   // finished watches (and their run dirs) are pruned after this
const MAX_HISTORY = 500;
const STRIP_ENV = /^(CLAUDECODE|CLAUDE_CODE_.*|AXO_TOKEN|AXO_AGENT_.*|ELECTRON_RUN_AS_NODE)$/;

/** Environment for watch commands: the node's env minus agent identity and Electron's run-as-node flag. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP_ENV.test(k)) env[k] = v;
  return env;
}

export interface WatchesOptions {
  minPollMs?: number;       // floor for until-mode intervals (tests lower it)
  commandPollMs?: number;   // how often to stat the exit sentinel
}

interface Row extends Watch { pollMs: number; pid: number | null }
interface Timers { poll: NodeJS.Timeout | null; deadline: NodeJS.Timeout | null; checking: boolean }

/**
 * Watches: detached jobs (or polled conditions) that wake an agent, by ID, when they finish.
 *
 * command: `run.sh` runs the command in a subshell, appends output to `out.log`, then atomically
 *   writes the exit code to `exit`. It is detached, so it outlives the node; on restart we re-arm
 *   and poll the sentinel again.
 * until: run a check command every interval; exit 0 fires the watch.
 *
 * Ported from Groove's watcher.js, persisted in SQLite. Two fixes: wake by agent ID (IDs are
 * permanent in Axo, so no name lookup), and team-level watches for worktree setup commands.
 */
export class Watches {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly runtime: AgentRuntime;
  private readonly runsDir: string;
  private readonly binDir: string | null;
  private readonly minPollMs: number;
  private readonly commandPollMs: number;
  private readonly timers = new Map<string, Timers>();

  constructor(store: Store, bus: EventBus, runtime: AgentRuntime, home: string, binDir: string | null, opts: WatchesOptions = {}) {
    this.store = store;
    this.bus = bus;
    this.runtime = runtime;
    this.runsDir = join(home, 'watches');
    this.binDir = binDir;
    this.minPollMs = opts.minPollMs ?? 3000;
    this.commandPollMs = opts.commandPollMs ?? 500;
    mkdirSync(this.runsDir, { recursive: true });
    runtime.on('gone', (e: { agentId: string; reason: string }) => {
      if (e.reason === 'delete') this.cancelForAgent(e.agentId);
    });
  }

  // ── create / cancel ──────────────────────────────────────

  create(req: CreateWatchReq & { teamId?: string; cwd?: string }): { watch: Watch; reattached: boolean } {
    const command = typeof req.command === 'string' ? req.command.trim() : '';
    const until = typeof req.until === 'string' ? req.until.trim() : '';
    if (!command && !until) throw new HttpError(400, 'give either a command to run or an --until check to poll');
    if (command && until) throw new HttpError(400, 'give a command or an --until check, not both');

    const agent = req.agentId ? this.runtime.get(req.agentId) : null;
    const team = req.teamId ? this.store.getTeam(req.teamId) : null;
    if (!agent && !team) throw new HttpError(400, 'agentId required');
    const cwd = req.cwd ?? agent?.workdir ?? team?.worktreePath ?? '';
    if (!cwd || !existsSync(cwd)) throw new HttpError(400, `working directory missing: ${cwd}`);

    if (agent) {
      const active = this.rows("status = 'active' AND agent_id = ?", agent.id);
      // Re-attach, never re-run: an agent resumed after a restart may re-issue a watch it thinks
      // never completed; a second copy of a long job in the same dir would corrupt the first.
      const dup = command && active.find((w) => w.mode === 'command' && w.command === command && this.jobAlive(w));
      if (dup) return { watch: pub(dup), reattached: true };
      if (active.length >= MAX_ACTIVE_PER_AGENT) {
        throw new HttpError(429, `you already have ${MAX_ACTIVE_PER_AGENT} active watches; cancel one first (axo watch cancel <id>)`);
      }
    }

    const timeoutMs = clamp(Number(req.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    const w: Row = {
      id: ulid(), agentId: agent?.id ?? null, agentName: agent?.name ?? null, teamId: team?.id ?? agent?.teamId ?? null,
      label: String(req.label || command || until).slice(0, 120), mode: (command ? 'command' : 'until') as WatchMode,
      command, until, cwd, timeoutMs, status: 'active', createdAt: Date.now(), finishedAt: null, result: null,
      pollMs: Math.max(Number(req.intervalMs) || DEFAULT_POLL_MS, this.minPollMs), pid: null,
    };
    this.insert(w);
    if (w.mode === 'command') this.launch(w);
    this.arm(w);
    this.emit(w);
    return { watch: pub(w), reattached: false };
  }

  cancel(id: string, byAgentId: string | null = null): Watch {
    const w = this.row(id);
    if (!w || (byAgentId && w.agentId !== byAgentId)) throw new HttpError(404, 'watch not found');
    if (w.status === 'active') {
      this.disarm(w.id);
      this.killJob(w);
      this.finish(w, 'cancelled', null);
    }
    return pub(w);
  }

  /** Start a fresh copy of a finished watch (same owner, command and limits). */
  rerun(id: string, byAgentId: string | null = null): { watch: Watch; reattached: boolean } {
    const w = this.row(id);
    if (!w || (byAgentId && w.agentId !== byAgentId)) throw new HttpError(404, 'watch not found');
    if (w.status === 'active') throw new HttpError(409, 'watch is still active');
    return this.create({
      agentId: w.agentId ?? undefined, teamId: w.agentId ? undefined : w.teamId ?? undefined, cwd: w.cwd,
      command: w.command || undefined, until: w.until || undefined, label: w.label, timeoutMs: w.timeoutMs, intervalMs: w.pollMs,
    });
  }

  list(filter: { agentId?: string | null; teamId?: string | null } = {}): Watch[] {
    if (filter.agentId) return this.rows('agent_id = ? ORDER BY created_at DESC', filter.agentId).map(pub);
    if (filter.teamId) return this.rows('team_id = ? ORDER BY created_at DESC', filter.teamId).map(pub);
    return this.rows('1 = 1 ORDER BY created_at DESC LIMIT 500').map(pub);
  }

  get(id: string): Watch {
    const w = this.row(id);
    if (!w) throw new HttpError(404, 'watch not found');
    return pub(w);
  }

  /** Tail of a command watch's output (live while running, trimmed log after). */
  output(id: string, bytes = 16 * 1024): string {
    const w = this.row(id);
    if (!w) throw new HttpError(404, 'watch not found');
    if (w.mode !== 'command') return w.result?.output ?? '';
    return tailFile(join(this.runsDir, w.id, 'out.log'), clamp(bytes, 1, 256 * 1024));
  }

  // ── node lifecycle ───────────────────────────────────────

  /** Re-arm active watches after a node restart; their detached jobs kept running. */
  restore(): number {
    this.prune();
    let n = 0;
    for (const w of this.rows("status = 'active'")) {
      if (w.mode === 'command' && !existsSync(this.exitFile(w)) && !this.jobAlive(w)) {
        this.wake(w, {
          outcome: 'error', exitCode: null, output: tailFile(this.outFile(w), OUTPUT_TAIL),
          summary: `The job for "${w.label}" stopped running without recording an exit code (lost while the node was down). Check its output before assuming it finished.`,
        });
        continue;
      }
      this.arm(w);
      n++;
    }
    return n;
  }

  /** Clear timers only: detached jobs must survive the node; restore() reconnects to them. */
  stop(): void {
    for (const id of [...this.timers.keys()]) this.disarm(id);
  }

  cancelForAgent(agentId: string): void {
    for (const w of this.rows("status = 'active' AND agent_id = ?", agentId)) {
      this.disarm(w.id);
      this.killJob(w);
      this.finish(w, 'cancelled', null);
    }
  }

  // ── running ──────────────────────────────────────────────

  private runDir(w: Row): string { return join(this.runsDir, w.id); }
  private outFile(w: Row): string { return join(this.runDir(w), 'out.log'); }
  private exitFile(w: Row): string { return join(this.runDir(w), 'exit'); }

  private launch(w: Row): void {
    const dir = this.runDir(w);
    mkdirSync(dir, { recursive: true });
    const exit = this.exitFile(w);
    // Subshell so the command's own `exit N` can't skip the sentinel; append (never truncate) the
    // log; publish the exit code atomically so the poller never reads a half-written value.
    const script = [
      '#!/bin/sh',
      '(',
      w.command,
      `) >> ${shq(this.outFile(w))} 2>&1 < /dev/null`,
      `echo $? > ${shq(exit)}.tmp && mv ${shq(exit)}.tmp ${shq(exit)}`,
      '',
    ].join('\n');
    const runSh = join(dir, 'run.sh');
    writeFileSync(runSh, script, { mode: 0o700 });
    const env = cleanEnv();
    env.AXO_WATCH_ID = w.id;
    if (this.binDir) env.PATH = `${this.binDir}:${env.PATH ?? ''}`;
    try {
      const child = spawn('/bin/sh', [runSh], { cwd: w.cwd, env, detached: true, stdio: 'ignore' });
      child.on('error', () => { /* reported via missing pid below */ });
      child.unref();
      w.pid = child.pid ?? null;
    } catch { w.pid = null; }
    if (!w.pid) writeFileSync(exit, '127\n'); // could not start: fire as a failure on the first tick
    this.store.db.prepare('UPDATE watches SET pid = ? WHERE id = ?').run(w.pid, w.id);
  }

  private jobAlive(w: Row): boolean {
    if (w.mode !== 'command' || !w.pid || existsSync(this.exitFile(w))) return false;
    try { process.kill(w.pid, 0); return true; } catch { return false; }
  }

  private arm(w: Row): void {
    const t: Timers = { poll: null, deadline: null, checking: false };
    this.timers.set(w.id, t);
    const remaining = Math.max(50, w.timeoutMs - (Date.now() - w.createdAt));
    t.deadline = setTimeout(() => this.onTimeout(w.id), remaining);
    t.poll = setInterval(() => this.tick(w.id), w.mode === 'command' ? this.commandPollMs : w.pollMs);
    t.deadline.unref();
    t.poll.unref();
    this.tick(w.id); // may already be done (finished while the node was down)
  }

  private disarm(id: string): void {
    const t = this.timers.get(id);
    if (!t) return;
    if (t.poll) clearInterval(t.poll);
    if (t.deadline) clearTimeout(t.deadline);
    this.timers.delete(id);
  }

  private tick(id: string): void {
    const t = this.timers.get(id);
    const w = this.row(id);
    if (!t || !w || w.status !== 'active') return;
    if (w.mode === 'command') {
      let code: number;
      try { code = parseInt(readFileSync(this.exitFile(w), 'utf8').trim(), 10); } catch { return; }
      if (Number.isNaN(code)) return;
      this.wake(w, {
        outcome: code === 0 ? 'success' : 'failure', exitCode: code,
        summary: `Finished with exit code ${code}.`, output: tailFile(this.outFile(w), OUTPUT_TAIL),
      });
      return;
    }
    if (t.checking) return; // previous check still running
    t.checking = true;
    const chunks: Buffer[] = [];
    const check = spawn('/bin/sh', ['-c', w.until], { cwd: w.cwd, env: { ...cleanEnv(), ...(this.binDir ? { PATH: `${this.binDir}:${process.env.PATH ?? ''}` } : {}) }, timeout: Math.max(w.pollMs, 5000) });
    check.stdout.on('data', (b: Buffer) => chunks.push(b));
    check.stderr.on('data', (b: Buffer) => chunks.push(b));
    check.on('error', () => { t.checking = false; });
    check.on('close', (code) => {
      t.checking = false;
      if (!this.timers.has(id)) return; // disarmed (cancelled, fired or node stopping)
      const cur = this.row(id);
      if (code !== 0 || !cur || cur.status !== 'active') return;
      this.wake(cur, {
        outcome: 'success', exitCode: 0, summary: 'Your watch condition is now true.',
        output: Buffer.concat(chunks).toString('utf8').slice(-OUTPUT_TAIL).trim(),
      });
    });
  }

  private onTimeout(id: string): void {
    const w = this.row(id);
    if (!w || w.status !== 'active') return;
    this.wake(w, {
      outcome: 'timeout', exitCode: null, output: w.mode === 'command' ? tailFile(this.outFile(w), OUTPUT_TAIL) : '',
      summary: `Hit its ${fmtDuration(w.timeoutMs)} time limit without finishing.${w.mode === 'command' ? ' The job may still be running; check on it directly.' : ''}`,
    });
  }

  private wake(w: Row, result: WatchResult): void {
    if (w.status !== 'active') return;
    this.disarm(w.id);
    const msg = compose(w, result);
    let status: WatchStatus = 'delivered';
    if (w.agentId) {
      try { this.runtime.deliver(w.agentId, msg, 'watch'); } catch { status = 'undeliverable'; }
    } else if (w.teamId) {
      // Team watch (worktree setup): tell every started agent in the team.
      for (const a of this.runtime.list()) {
        if (a.teamId === w.teamId && a.sessionId && a.status !== 'stopped') {
          try { this.runtime.deliver(a.id, msg, 'watch'); } catch { /* agent gone */ }
        }
      }
    }
    this.finish(w, status, result);
  }

  private finish(w: Row, status: WatchStatus, result: WatchResult | null): void {
    w.status = status;
    w.result = result;
    w.finishedAt = Date.now();
    this.store.db.prepare('UPDATE watches SET status = ?, result = ?, finished_at = ? WHERE id = ?')
      .run(status, result ? JSON.stringify(result) : null, w.finishedAt, w.id);
    trimFile(this.outFile(w), KEEP_LOG_BYTES);
    this.emit(w);
  }

  private killJob(w: Row): void {
    if (w.mode !== 'command' || !w.pid) return;
    try { process.kill(-w.pid, 'SIGTERM'); } catch { try { process.kill(w.pid, 'SIGTERM'); } catch { /* gone */ } }
  }

  private prune(): void {
    const cutoff = Date.now() - HISTORY_MS;
    const old = this.store.db.prepare(`SELECT id FROM watches WHERE status != 'active' AND (finished_at < ? OR id NOT IN (
      SELECT id FROM watches WHERE status != 'active' ORDER BY created_at DESC LIMIT ?))`).all(cutoff, MAX_HISTORY) as { id: string }[];
    for (const { id } of old) {
      rmSync(join(this.runsDir, id), { recursive: true, force: true });
      this.store.db.prepare('DELETE FROM watches WHERE id = ?').run(id);
    }
  }

  // ── store ────────────────────────────────────────────────

  private insert(w: Row): void {
    this.store.db.prepare(`INSERT INTO watches (id, agent_id, team_id, label, mode, command, until_cmd, cwd, poll_ms, timeout_ms,
      status, pid, result, created_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(w.id, w.agentId, w.teamId, w.label, w.mode, w.command, w.until, w.cwd, w.pollMs, w.timeoutMs, w.status, w.pid,
        null, w.createdAt, null);
  }
  private row(id: string): Row | null { return this.rows('id = ?', id)[0] ?? null; }
  private rows(where: string, ...args: (string | number)[]): Row[] {
    return (this.store.db.prepare(`SELECT * FROM watches WHERE ${where}`).all(...args) as Record<string, any>[]).map((r) => ({
      id: r.id, agentId: r.agent_id, agentName: r.agent_id ? (this.store.getAgent(r.agent_id)?.name ?? null) : null,
      teamId: r.team_id, label: r.label, mode: r.mode, command: r.command, until: r.until_cmd, cwd: r.cwd,
      timeoutMs: r.timeout_ms, status: r.status, createdAt: r.created_at, finishedAt: r.finished_at,
      result: r.result ? JSON.parse(r.result) : null, pollMs: r.poll_ms, pid: r.pid,
    }));
  }
  private emit(w: Row): void { this.bus.publish({ type: 'watch:upsert', watch: pub(w) }); }
}

// ── helpers ─────────────────────────────────────────────────

function pub(w: Row): Watch {
  const { pollMs: _p, pid: _pid, ...rest } = w;
  return rest;
}

function compose(w: Row, r: WatchResult): string {
  const lines = [`[Watch ${w.id} fired: "${w.label}"]`, '', r.summary];
  if (r.output) lines.push('', 'Output (last 4KB):', '```', r.output, '```');
  lines.push('', w.agentId
    ? 'This is the notification you set up earlier. Continue from here and report to the user.'
    : 'This is your team\'s worktree setup command. Continue from here.');
  return lines.join('\n');
}

function clamp(n: number, lo: number, hi: number): number { return Math.min(Math.max(n, lo), hi); }

export function fmtDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** Last `maxBytes` of a file without reading all of it (training logs can be huge). */
export function tailFile(path: string, maxBytes: number): string {
  if (!existsSync(path)) return '';
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').trim();
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function trimFile(path: string, keep: number): void {
  try {
    if (!existsSync(path)) return;
    const tail = tailFile(path, keep);
    truncateSync(path, 0);
    writeFileSync(path, tail);
  } catch { /* best effort */ }
}
