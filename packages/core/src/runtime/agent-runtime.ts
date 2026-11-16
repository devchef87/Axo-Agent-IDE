import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Agent, CreateAgentReq, FeedItem, UpdateAgentReq } from '@axo/protocol';
import type { Store } from '../store/db.ts';
import type { EventBus } from '../events.ts';
import type { NodeConfig } from '../config.ts';
import type { Projects } from '../projects.ts';
import { ClaudeProcess } from './claude-process.ts';
import { parseLine, ParseContext, contextWindowFor, type Action } from './parser.ts';
import { buildSystemPrompt } from './system-prompt.ts';
import { ulid } from '../util/ulid.ts';
import { HttpError } from '../util/http-error.ts';

interface Queued { text: string; author: string }

interface Live {
  proc: ClaudeProcess;
  ctx: ParseContext;
  turnActive: boolean;
  turnStartedAt: number;
  sawInit: boolean;
  interruptRequested: boolean;
  interruptTimers: NodeJS.Timeout[];
  /** Why we're ending this process, if we are. Unset = unexpected exit. */
  ending: 'sleep' | 'stop' | 'delete' | null;
  toolStarts: Map<string, number>;
  /** Messages sent for the current turn; re-queued if the process dies before Claude starts. */
  inflight: Queued[];
  /** Assistant prose produced during the current turn (for turn-end listeners). */
  turnText: string[];
}

/**
 * Hooks for other subsystems (InnerChat, journalist, rotator). Subscribe via
 * `runtime.on('turn-end', (e: TurnEndEvent) => …)`; never reach into internals.
 */
export interface TurnEndEvent {
  agentId: string;
  sessionId: string | null;
  /** Prose from this turn, joined; the last block is usually the answer. */
  text: string;
  lastText: string;
  isError: boolean;
  interrupted: boolean;
  /** Messages that started this turn. */
  inputs: { text: string; author: string }[];
}

export interface RuntimeOptions {
  interruptGraceMs?: number;   // wait for control_request interrupt before SIGINT
  crashWindowMs?: number;
  crashLimit?: number;
}

const DEFAULT_MODEL = 'opus';
const STRIP_ENV = /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_AGENT_SDK_VERSION|GROOVE_.*|AXO_.*)$/;

export class AgentRuntime extends EventEmitter {
  private readonly agents = new Map<string, Agent>();
  private readonly live = new Map<string, Live>();
  private readonly queues = new Map<string, Queued[]>();
  private readonly crashes = new Map<string, number[]>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly emitTimers = new Map<string, NodeJS.Timeout>();
  private readonly opts: Required<RuntimeOptions>;
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly cfg: NodeConfig;
  private readonly projects: Projects;

  constructor(store: Store, bus: EventBus, cfg: NodeConfig, projects: Projects, opts: RuntimeOptions = {}) {
    super();
    this.setMaxListeners(50);
    this.store = store;
    this.bus = bus;
    this.cfg = cfg;
    this.projects = projects;
    this.opts = { interruptGraceMs: 8000, crashWindowMs: 120_000, crashLimit: 3, ...opts };
    for (const a of store.listAgents()) this.agents.set(a.id, a);
  }

  // ── lifecycle of the node ─────────────────────────────────

  /** Kill orphaned claude processes from a previous node run and normalize statuses. */
  startup(): void {
    for (const { agentId, pid } of this.store.livePids()) {
      if (isClaudePid(pid)) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
      }
      this.store.setLivePid(agentId, null);
    }
    for (const a of this.agents.values()) {
      if (a.status !== 'stopped' && a.status !== 'error' && a.status !== 'asleep') {
        a.status = 'asleep';
        this.store.saveAgent(a);
      }
    }
  }

  async shutdown(): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const [id, l] of this.live) {
      l.ending = 'sleep';
      waits.push(new Promise((res) => {
        l.proc.once('exit', () => res());
        l.proc.endInput();
        setTimeout(() => l.proc.kill('SIGTERM'), 1500).unref();
        setTimeout(() => { l.proc.kill('SIGKILL'); res(); }, 4000).unref();
      }));
      this.clearIdle(id);
    }
    await Promise.all(waits);
  }

  // ── queries ───────────────────────────────────────────────

  list(): Agent[] { return [...this.agents.values()].map((a) => this.view(a)); }
  get(id: string): Agent {
    const a = this.agents.get(id);
    if (!a) throw new HttpError(404, 'agent not found');
    return a;
  }
  private view(a: Agent): Agent { return { ...a, queued: this.queues.get(a.id)?.length ?? 0 }; }

  // ── CRUD ──────────────────────────────────────────────────

  create(req: CreateAgentReq): Agent {
    const project = this.store.getProject(req.projectId);
    if (!project) throw new HttpError(404, 'project not found');
    const team = req.teamId ? this.store.getTeam(req.teamId) : this.projects.defaultTeam(project);
    if (!team || team.projectId !== project.id) throw new HttpError(400, 'invalid team');

    const role = (req.role || 'fullstack').trim().toLowerCase();
    let name = (req.name || '').trim();
    if (name) {
      if (!/^[\w.-]{1,40}$/.test(name)) throw new HttpError(400, 'name may only contain letters, numbers, . _ -');
      if (this.store.agentNameTaken(project.id, name)) throw new HttpError(409, `an agent named ${name} already exists`);
    } else {
      let n = 1;
      while (this.store.agentNameTaken(project.id, `${role}-${n}`)) n++;
      name = `${role}-${n}`;
    }

    const model = req.model || DEFAULT_MODEL;
    const now = Date.now();
    const agent: Agent = {
      id: ulid(), projectId: project.id, teamId: team.id, name, role, model, effort: req.effort ?? null,
      scopeGlobs: [], instructions: req.instructions ?? '', workdir: team.worktreePath ?? project.path,
      status: 'asleep', sessionId: null, generation: 0, queued: 0, contextTokens: 0,
      contextWindow: contextWindowFor(model), sessionTokens: 0, compactions: 0, lastError: null,
      createdAt: now, lastActiveAt: now,
    };
    this.store.insertAgent(agent);
    this.agents.set(agent.id, agent);
    this.emitAgent(agent);
    if (req.task?.trim()) this.deliver(agent.id, req.task, 'user');
    return this.view(agent);
  }

  update(id: string, req: UpdateAgentReq): Agent {
    const a = this.get(id);
    if (req.name !== undefined && req.name !== a.name) {
      const name = req.name.trim();
      if (!/^[\w.-]{1,40}$/.test(name)) throw new HttpError(400, 'invalid name');
      if (this.store.agentNameTaken(a.projectId, name, a.id)) throw new HttpError(409, 'name taken');
      a.name = name;
    }
    // Model/effort/instructions apply on the next process start (system prompt and flags are fixed per process).
    if (req.model !== undefined) { a.model = req.model; a.contextWindow = contextWindowFor(req.model); }
    if (req.effort !== undefined) a.effort = req.effort;
    if (req.instructions !== undefined) a.instructions = req.instructions;
    if (req.scopeGlobs !== undefined) a.scopeGlobs = req.scopeGlobs;
    this.store.saveAgent(a);
    // If idle, recycle the process so new settings take effect on the next message.
    const l = this.live.get(id);
    if (l && !l.turnActive) this.endProcess(id, 'sleep');
    this.emitAgent(a);
    return this.view(a);
  }

  async remove(id: string): Promise<void> {
    this.get(id);
    this.queues.delete(id);
    await this.endProcess(id, 'delete');
    this.clearIdle(id);
    this.agents.delete(id);
    this.store.deleteAgent(id);
    this.bus.publish({ type: 'agent:removed', agentId: id });
  }

  // ── messaging ─────────────────────────────────────────────

  /** The single entry point for every inbound message (user, teammate, watch, axo). */
  deliver(id: string, text: string, author = 'user'): void {
    const a = this.get(id);
    if (!text.trim()) throw new HttpError(400, 'empty message');
    if (a.status === 'stopped' || a.status === 'error') {
      a.status = 'asleep';
      a.lastError = null;
      this.crashes.delete(id);
    }
    this.addFeed(a, { kind: 'user', id: `u-${ulid()}`, ts: Date.now(), text, author });
    const q = this.queues.get(id) ?? [];
    q.push({ text, author });
    this.queues.set(id, q);
    this.pump(id);
  }

  /** Send queued messages if the agent is at a turn boundary. */
  private pump(id: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    const q = this.queues.get(id);
    const l = this.live.get(id);
    if (!q?.length || l?.turnActive || a.status === 'rotating' || a.status === 'error') {
      this.emitAgent(a);
      return;
    }
    const live = l ?? this.spawn(a);
    if (!live) return;
    const msgs = q.splice(0);
    const ok = live.proc.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: combine(msgs) }] } });
    if (!ok) { q.unshift(...msgs); return; }
    this.clearIdle(id);
    live.inflight = msgs;
    live.turnText = [];
    live.turnActive = true;
    live.turnStartedAt = Date.now();
    live.interruptRequested = false;
    a.status = 'working';
    a.lastActiveAt = Date.now();
    this.store.saveAgent(a);
    this.emitAgent(a);
  }

  interrupt(id: string): void {
    const a = this.get(id);
    const l = this.live.get(id);
    if (!l?.turnActive) return;
    l.interruptRequested = true;
    l.proc.send({ type: 'control_request', request_id: `int-${ulid()}`, request: { subtype: 'interrupt' } });
    // Fallback if the CLI ignores the interrupt: SIGINT, then SIGKILL. Session is resumable either way.
    l.interruptTimers.push(setTimeout(() => {
      if (this.live.get(id) === l && l.turnActive) {
        this.addFeed(a, sys('warn', 'Interrupt not acknowledged; terminating process (session will resume).'));
        l.ending = 'sleep';
        l.proc.kill('SIGINT');
        l.interruptTimers.push(setTimeout(() => l.proc.kill('SIGKILL'), 4000));
      }
    }, this.opts.interruptGraceMs));
  }

  /** User-initiated stop: end the process; agent stays, resumes on next message. */
  async stop(id: string): Promise<void> {
    this.get(id);
    this.queues.delete(id);
    await this.endProcess(id, 'stop');
    const a = this.get(id);
    if (!this.live.has(id)) { a.status = 'stopped'; this.store.saveAgent(a); this.emitAgent(a); }
  }

  // ── process management ───────────────────────────────────

  private spawn(a: Agent): Live | null {
    const project = this.store.getProject(a.projectId);
    const team = this.store.getTeam(a.teamId);
    if (!project || !team) {
      this.fail(a, 'project or team missing');
      return null;
    }

    const resume = !!a.sessionId && this.store.sessionInitialized(a.sessionId);
    if (!resume) {
      a.sessionId = randomUUID();
      this.store.insertSession(a.sessionId, a.id, a.generation);
      a.contextTokens = 0;
      a.sessionTokens = 0;
      a.compactions = 0;
    }

    const prompt = buildSystemPrompt({
      agent: a, project, team, hostname: this.cfg.hostname,
      teammates: [...this.agents.values()].filter((x) => x.teamId === a.teamId),
    });
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages',
      resume ? '--resume' : '--session-id', a.sessionId!,
      '--permission-mode', 'bypassPermissions',
      '--disallowedTools', 'AskUserQuestion',
      '--append-system-prompt', prompt,
      '--model', a.model,
    ];
    if (a.effort) args.push('--effort', a.effort);

    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!STRIP_ENV.test(k)) env[k] = v;
    if (this.cfg.authMode === 'subscription') delete env.ANTHROPIC_API_KEY;
    env.AXO_AGENT_ID = a.id;
    env.AXO_AGENT_NAME = a.name;
    env.AXO_NODE_URL = `http://${this.cfg.host}:${this.cfg.port}`;
    env.AXO_TOKEN = this.cfg.token;

    const proc = new ClaudeProcess({ bin: this.cfg.claudeBin, args, cwd: a.workdir, env });
    const live: Live = {
      proc, ctx: new ParseContext(a.workdir), turnActive: false, turnStartedAt: 0, sawInit: false,
      interruptRequested: false, interruptTimers: [], ending: null, toolStarts: new Map(), inflight: [], turnText: [],
    };
    this.live.set(a.id, live);
    proc.on('line', (line: string) => this.onLine(a.id, live, line));
    proc.on('exit', (code: number | null, signal: string | null) => this.onExit(a.id, live, code, signal));
    proc.start();
    this.store.setLivePid(a.id, proc.pid);
    a.status = 'starting';
    if (resume) a.lastError = null;
    return live;
  }

  private endProcess(id: string, why: 'sleep' | 'stop' | 'delete'): Promise<void> {
    const l = this.live.get(id);
    if (!l) return Promise.resolve();
    l.ending = why;
    return new Promise((res) => {
      l.proc.once('exit', () => res());
      if (l.turnActive) l.proc.kill('SIGTERM');
      else l.proc.endInput();
      setTimeout(() => l.proc.kill('SIGTERM'), 3000).unref();
      setTimeout(() => { l.proc.kill('SIGKILL'); res(); }, 6000).unref();
    });
  }

  private onLine(id: string, live: Live, line: string): void {
    if (this.live.get(id) !== live) return;
    const a = this.agents.get(id);
    if (!a) return;
    for (const act of parseLine(line, live.ctx)) this.apply(a, live, act);
  }

  private apply(a: Agent, live: Live, act: Action): void {
    switch (act.type) {
      case 'session':
        if (!live.sawInit && a.sessionId) this.store.markSessionInitialized(a.sessionId);
        live.sawInit = true;
        if (a.status === 'starting') { a.status = live.turnActive ? 'working' : 'idle'; this.emitAgent(a); }
        break;

      case 'feed':
        if (act.item.kind === 'tool') live.toolStarts.set(act.item.id, act.item.ts);
        if (act.item.kind === 'text') live.turnText.push(act.item.text);
        this.addFeed(a, act.item);
        break;

      case 'text-delta':
        this.bus.publish({ type: 'agent:text-delta', agentId: a.id, itemId: act.itemId, text: act.text });
        break;

      case 'tool-result': {
        const item = this.store.getFeedItem(a.id, act.toolUseId);
        if (item?.kind !== 'tool') break;
        const started = live.toolStarts.get(act.toolUseId);
        live.toolStarts.delete(act.toolUseId);
        this.addFeed(a, { ...item, status: act.isError ? 'error' : 'ok', result: act.content,
          durationMs: started ? act.ts - started : undefined });
        break;
      }

      case 'context':
        a.contextTokens = act.tokens;
        this.emitAgentSoon(a);
        break;

      case 'compact':
        a.compactions++;
        this.addFeed(a, sys('info', `Context compacted${act.preTokens ? ` (was ${Math.round(act.preTokens / 1000)}k tokens)` : ''}.`));
        this.emitAgentSoon(a);
        break;

      case 'turn-end':
        this.onTurnEnd(a, live, act);
        break;

      case 'rate-limit':
        this.bus.publish({ type: 'rate-limit', info: act.info });
        break;

      default:
        break;
    }
  }

  private onTurnEnd(a: Agent, live: Live, act: Extract<Action, { type: 'turn-end' }>): void {
    if (!live.turnActive) return; // spurious result (e.g. emitted on --resume with no turn)
    live.turnActive = false;
    const inputs = live.inflight;
    live.inflight = [];
    for (const t of live.interruptTimers) clearTimeout(t);
    live.interruptTimers = [];
    this.failRunningTools(a, live, act.isError ? 'interrupted' : null);

    const u = act.usage;
    const fresh = u.input + u.output + u.cacheCreation;
    a.sessionTokens += fresh;
    a.lastActiveAt = Date.now();
    if (a.sessionId) {
      this.store.recordTurn(a.sessionId, { ...u, context: a.contextTokens });
      this.store.insertUsage(a.id, a.sessionId, u);
    }
    this.addFeed(a, {
      kind: 'turn', id: `turn-${ulid()}`, ts: Date.now(), isError: act.isError && !live.interruptRequested,
      durationMs: act.durationMs, costUsd: u.costUsd, numTurns: act.numTurns,
      interrupted: live.interruptRequested || undefined,
    });
    const interrupted = live.interruptRequested;
    live.interruptRequested = false;
    a.status = 'idle';
    this.store.saveAgent(a);
    this.store.pruneFeed(a.id);
    this.emitAgent(a);
    const ev: TurnEndEvent = {
      agentId: a.id, sessionId: a.sessionId, text: live.turnText.join('\n\n'), lastText: live.turnText.at(-1) ?? '',
      isError: act.isError && !interrupted, interrupted, inputs,
    };
    try { this.emit('turn-end', ev); } catch (e) { console.error('[runtime] turn-end listener failed', e); }
    this.pump(a.id);
    if (!live.turnActive) this.armIdle(a.id);
  }

  private onExit(id: string, live: Live, code: number | null, signal: string | null): void {
    if (this.live.get(id) !== live) return;
    this.live.delete(id);
    for (const t of live.interruptTimers) clearTimeout(t);
    this.clearIdle(id);
    this.store.setLivePid(id, null);
    const a = this.agents.get(id);
    if (!a) return;
    const wasTurn = live.turnActive;
    this.failRunningTools(a, live, 'process exited');

    if (live.ending === 'delete') return;
    if (live.ending === 'stop') {
      a.status = 'stopped';
    } else if (live.ending === 'sleep') {
      a.status = 'asleep';
      if (wasTurn) this.addFeed(a, sys('warn', 'Turn ended early; the session is saved and will resume on your next message.'));
    } else {
      this.handleCrash(a, live, code, signal, wasTurn);
      return;
    }
    this.store.saveAgent(a);
    this.emitAgent(a);
    this.pump(id); // messages may have queued while shutting down
  }

  private handleCrash(a: Agent, live: Live, code: number | null, signal: string | null, wasTurn: boolean): void {
    const stderr = live.proc.stderrTail.join('\n');
    const requeue = (msgs: Queued[]) => {
      if (!msgs.length) return;
      this.queues.set(a.id, [...msgs, ...(this.queues.get(a.id) ?? [])]);
    };

    // Session file missing on this machine (e.g. ~/.claude cleaned): start fresh instead of crash-looping.
    if (!live.sawInit && /no conversation found/i.test(stderr)) {
      this.addFeed(a, sys('warn', 'Previous Claude session could not be resumed; starting a new session.'));
      a.sessionId = null;
      a.status = 'asleep';
      this.store.saveAgent(a);
      requeue(live.inflight);
      this.pump(a.id);
      return;
    }

    const now = Date.now();
    const recent = (this.crashes.get(a.id) ?? []).filter((t) => now - t < this.opts.crashWindowMs);
    recent.push(now);
    this.crashes.set(a.id, recent);
    const detail = stderr.split('\n').slice(-6).join('\n') || `exit code ${code ?? '?'}${signal ? ` (${signal})` : ''}`;

    if (recent.length >= this.opts.crashLimit) {
      this.fail(a, `Claude process crashed ${recent.length} times in ${Math.round(this.opts.crashWindowMs / 1000)}s:\n${detail}`);
      return;
    }
    this.addFeed(a, sys('error', `Claude process exited unexpectedly:\n${detail}`));
    a.status = 'asleep';
    this.store.saveAgent(a);
    this.emitAgent(a);
    if (wasTurn && !live.sawInit) {
      requeue(live.inflight); // Claude never saw it; send it again
    } else if (wasTurn) {
      // Re-prime so work continues; the session already holds the conversation.
      requeue([{ text: 'Your previous turn was cut off by a process crash. Check the current state and continue where you left off.', author: 'axo' }]);
    }
    this.pump(a.id);
  }

  private fail(a: Agent, message: string): void {
    a.status = 'error';
    a.lastError = message;
    this.addFeed(a, sys('error', message));
    this.store.saveAgent(a);
    this.emitAgent(a);
  }

  private failRunningTools(a: Agent, live: Live, reason: string | null): void {
    if (!live.toolStarts.size) return;
    for (const toolId of live.toolStarts.keys()) {
      const item = this.store.getFeedItem(a.id, toolId);
      if (item?.kind === 'tool' && item.status === 'running') {
        this.addFeed(a, { ...item, status: reason ? 'error' : 'ok', result: reason ?? item.result });
      }
    }
    live.toolStarts.clear();
  }

  // ── idle reaping ─────────────────────────────────────────

  private armIdle(id: string): void {
    this.clearIdle(id);
    const t = setTimeout(() => {
      const l = this.live.get(id);
      if (l && !l.turnActive && !this.queues.get(id)?.length) this.endProcess(id, 'sleep');
    }, this.cfg.idleReapMs);
    t.unref();
    this.idleTimers.set(id, t);
  }
  private clearIdle(id: string): void {
    const t = this.idleTimers.get(id);
    if (t) { clearTimeout(t); this.idleTimers.delete(id); }
  }

  // ── events ───────────────────────────────────────────────

  private addFeed(a: Agent, item: FeedItem): void {
    this.store.upsertFeed(a.id, a.sessionId, item);
    this.bus.publish({ type: 'agent:feed', agentId: a.id, item });
  }

  private emitAgent(a: Agent): void {
    const t = this.emitTimers.get(a.id);
    if (t) { clearTimeout(t); this.emitTimers.delete(a.id); }
    this.bus.publish({ type: 'agent:upsert', agent: this.view(a) });
  }
  /** Throttled upsert for high-frequency fields (context tokens). */
  private emitAgentSoon(a: Agent): void {
    if (this.emitTimers.has(a.id)) return;
    this.emitTimers.set(a.id, setTimeout(() => { this.emitTimers.delete(a.id); this.emitAgent(a); }, 500));
  }
}

// ── helpers ─────────────────────────────────────────────────

function combine(msgs: Queued[]): string {
  if (msgs.length === 1 && msgs[0].author === 'user') return msgs[0].text;
  return msgs.map((m) => (m.author === 'user' ? m.text : `[from ${m.author}] ${m.text}`)).join('\n\n---\n\n');
}

function sys(level: 'info' | 'warn' | 'error', text: string): FeedItem {
  return { kind: 'system', id: `s-${ulid()}`, ts: Date.now(), level, text };
}

function isClaudePid(pid: number): boolean {
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return /claude/.test(cmd);
  } catch {
    return false;
  }
}
