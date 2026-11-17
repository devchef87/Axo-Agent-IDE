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
import { buildSystemPrompt, type PromptExtras } from './system-prompt.ts';
import type { SpawnSpec } from './claude-process.ts';
import { ulid } from '../util/ulid.ts';
import { HttpError } from '../util/http-error.ts';
import { ImageStore } from './images.ts';

interface Queued { text: string; author: string; id?: string } // [core2] id = feed item id, reported as TurnEndEvent.messageIds

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
  /** Settings changed mid-turn: restart the process at the next boundary so they apply. */
  recycle?: boolean;
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
  /** Fresh tokens (input + output + cache creation) used by this turn. */
  freshTokens: number;
  startedAt: number;
  /** [core2] Message ids (returned by deliver()) consumed by this turn. InnerChat matches replies with these. */
  messageIds?: string[];
}

// [core2] Also emitted on the runtime: 'deliver' (DeliverEvent) and 'gone' (GoneEvent).
export interface DeliverEvent { agentId: string; author: string; messageId: string }
export interface GoneEvent { agentId: string; reason: 'stop' | 'delete' | 'error' }
/** [core2] Last-moment additions to every claude spawn spec (knock --settings, PATH, per-agent token). */
export type SpecHook = (agent: Agent, spec: SpawnSpec) => void;

export type ContextProvider = (agent: Agent) => PromptExtras;

export interface RuntimeOptions {
  interruptGraceMs?: number;   // wait for control_request interrupt before SIGINT
  crashWindowMs?: number;
  crashLimit?: number;
}

const DEFAULT_MODEL = 'opus';
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function checkEffort(e: string | null | undefined): void {
  if (e != null && !EFFORTS.has(e)) throw new HttpError(400, `effort must be one of ${[...EFFORTS].join(', ')}`);
}
// ELECTRON_RUN_AS_NODE: the local node runs on Electron's binary; never leak that into agents
// (any Electron app an agent launched would silently run as plain node).
const STRIP_ENV = /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_AGENT_SDK_VERSION|GROOVE_.*|AXO_.*|ELECTRON_RUN_AS_NODE)$/;

/** Clean environment for any claude child process (no inherited agent identity, subscription auth by default). */
export function claudeEnv(cfg: { authMode: 'subscription' | 'api' }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP_ENV.test(k)) env[k] = v;
  if (cfg.authMode === 'subscription') delete env.ANTHROPIC_API_KEY;
  return env;
}

export class AgentRuntime extends EventEmitter {
  private readonly agents = new Map<string, Agent>();
  private readonly live = new Map<string, Live>();
  private readonly queues = new Map<string, Queued[]>();
  private readonly crashes = new Map<string, number[]>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly emitTimers = new Map<string, NodeJS.Timeout>();
  /** Agents whose queue is held while a rotation swaps processes. */
  private readonly held = new Set<string>();
  private readonly idleWaiters = new Map<string, (() => void)[]>();
  private contextProvider: ContextProvider = () => ({});
  private readonly opts: Required<RuntimeOptions>;
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly cfg: NodeConfig;
  private readonly projects: Projects;
  /** Images from tool results, stored as files (not in the feed). */
  readonly images: ImageStore;
  /** [core2] See SpecHook. Set by the node. */
  specHook: SpecHook | null = null;
  private shuttingDown = false; // [core2] no new processes once shutdown() starts

  constructor(store: Store, bus: EventBus, cfg: NodeConfig, projects: Projects, opts: RuntimeOptions = {}) {
    super();
    this.setMaxListeners(50);
    this.store = store;
    this.bus = bus;
    this.cfg = cfg;
    this.projects = projects;
    this.images = new ImageStore(cfg.home);
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
    this.shuttingDown = true; // [core2]
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
  private view(a: Agent): Agent {
    return { ...a, status: this.held.has(a.id) ? 'rotating' : a.status, queued: this.queues.get(a.id)?.length ?? 0, preview: this.store.feedPreview(a.id) };
  }

  /** Journalist/introducer supply project map, decisions, state doc, handoff for system prompts. */
  setContextProvider(fn: ContextProvider): void { this.contextProvider = fn; }

  isTurnActive(id: string): boolean { return !!this.live.get(id)?.turnActive; }
  hasProcess(id: string): boolean { return this.live.has(id); }

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

    checkEffort(req.effort);
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

  /**
   * [core2] Point a not-yet-started agent at another directory (its own worktree). Only before the
   * first session: claude keys sessions by cwd, so moving later would break --resume.
   */
  setWorkdir(id: string, workdir: string): Agent {
    const a = this.get(id);
    if (a.sessionId || this.live.has(id)) throw new HttpError(409, 'workdir can only be set before the agent first runs');
    a.workdir = workdir;
    this.store.saveAgent(a);
    this.emitAgent(a);
    return this.view(a);
  }

  update(id: string, req: UpdateAgentReq): Agent {
    const a = this.get(id);
    if (req.name !== undefined && req.name !== a.name) {
      const name = req.name.trim();
      if (!/^[\w.-]{1,40}$/.test(name)) throw new HttpError(400, 'invalid name');
      if (this.store.agentNameTaken(a.projectId, name, a.id)) throw new HttpError(409, 'name taken');
      const from = a.name;
      a.name = name;
      this.emit('renamed', { agent: a, from });
    }
    // Model/effort/instructions apply on the next process start (system prompt and flags are fixed per process).
    if (req.model !== undefined) { a.model = req.model; a.contextWindow = contextWindowFor(req.model); }
    if (req.effort !== undefined) { checkEffort(req.effort); a.effort = req.effort; }
    if (req.instructions !== undefined) a.instructions = req.instructions;
    if (req.scopeGlobs !== undefined) a.scopeGlobs = req.scopeGlobs;
    this.store.saveAgent(a);
    // If idle, recycle the process so new settings take effect on the next message.
    const l = this.live.get(id);
    if (l && !l.turnActive) void this.endProcess(id, 'sleep');
    else if (l) l.recycle = true;
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
    this.images.remove(id);
    this.bus.publish({ type: 'agent:removed', agentId: id });
    this.emit('gone', { agentId: id, reason: 'delete' } satisfies GoneEvent); // [core2]
  }

  // ── messaging ─────────────────────────────────────────────

  /** The single entry point for every inbound message (user, teammate, watch, axo). */
  deliver(id: string, text: string, author = 'user'): string {
    const a = this.get(id);
    if (!text.trim()) throw new HttpError(400, 'empty message');
    if (a.status === 'stopped' || a.status === 'error') {
      a.status = 'asleep';
      a.lastError = null;
      this.crashes.delete(id);
    }
    const msgId = `u-${ulid()}`; // [core2] returned so callers can match the turn that consumed it
    this.addFeed(a, { kind: 'user', id: msgId, ts: Date.now(), text, author });
    const q = this.queues.get(id) ?? [];
    q.push({ text, author, id: msgId });
    this.queues.set(id, q);
    this.emit('deliver', { agentId: id, author, messageId: msgId } satisfies DeliverEvent); // [core2]
    this.pump(id);
    return msgId;
  }

  /** Send queued messages if the agent is at a turn boundary. */
  private pump(id: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    const q = this.queues.get(id);
    const l = this.live.get(id);
    if (!q?.length || l?.turnActive || this.held.has(id) || a.status === 'error') {
      this.emitAgent(a);
      return;
    }
    if (!l && this.shuttingDown) return; // [core2] queued messages wait for the next node start
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
    this.emit('gone', { agentId: id, reason: 'stop' } satisfies GoneEvent); // [core2]
  }

  // ── process management ───────────────────────────────────

  /** Build the claude command for an agent. Used by spawn() and by the rotator's warm-up process. */
  buildSpawnSpec(a: Agent, opts: { sessionId: string; resume: boolean; extraPrompt?: string }): SpawnSpec | null {
    const project = this.store.getProject(a.projectId);
    const team = this.store.getTeam(a.teamId);
    if (!project || !team) return null;
    let extras: PromptExtras = {};
    try { extras = this.contextProvider(a); } catch (e) { console.error('[runtime] context provider failed', e); }
    if (opts.extraPrompt) extras = { ...extras, handoff: opts.extraPrompt };
    const prompt = buildSystemPrompt({
      agent: a, project, team, hostname: this.cfg.hostname,
      teammates: [...this.agents.values()].filter((x) => x.teamId === a.teamId),
      extras,
    });
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages',
      opts.resume ? '--resume' : '--session-id', opts.sessionId,
      '--permission-mode', 'bypassPermissions',
      '--disallowedTools', 'AskUserQuestion',
      '--append-system-prompt', prompt,
      '--model', a.model,
    ];
    if (a.effort) args.push('--effort', a.effort);

    const env = claudeEnv(this.cfg);
    env.AXO_AGENT_ID = a.id;
    env.AXO_AGENT_NAME = a.name;
    env.AXO_NODE_URL = `http://${this.cfg.host}:${this.cfg.port}`;
    env.AXO_TOKEN = this.cfg.token;
    const spec: SpawnSpec = { bin: this.cfg.claudeBin, args, cwd: a.workdir, env };
    this.specHook?.(a, spec); // [core2]
    return spec;
  }

  private spawn(a: Agent): Live | null {
    const resume = !!a.sessionId && this.store.sessionInitialized(a.sessionId);
    const sessionId = resume ? a.sessionId! : randomUUID();
    const spec = this.buildSpawnSpec(a, { sessionId, resume });
    if (!spec) {
      this.fail(a, 'project or team missing');
      return null;
    }
    if (!resume) {
      a.sessionId = sessionId;
      this.store.insertSession(sessionId, a.id, a.generation);
      a.contextTokens = 0;
      a.sessionTokens = 0;
      a.compactions = 0;
    }
    const live = this.attach(a, new ClaudeProcess(spec));
    live.proc.start();
    this.store.setLivePid(a.id, live.proc.pid);
    a.status = 'starting';
    if (resume) a.lastError = null;
    return live;
  }

  private attach(a: Agent, proc: ClaudeProcess, sawInit = false): Live {
    const live: Live = {
      proc, ctx: new ParseContext(a.workdir), turnActive: false, turnStartedAt: 0, sawInit,
      interruptRequested: false, interruptTimers: [], ending: null, toolStarts: new Map(), inflight: [], turnText: [],
    };
    this.live.set(a.id, live);
    proc.on('line', (line: string) => this.onLine(a.id, live, line));
    proc.on('exit', (code: number | null, signal: string | null) => this.onExit(a.id, live, code, signal));
    return live;
  }

  // ── rotation support (used by the rotator) ───────────────

  /** Resolve when the agent is between turns (or has no process). */
  whenIdle(id: string): Promise<void> {
    if (!this.live.get(id)?.turnActive) return Promise.resolve();
    return new Promise((res) => {
      const list = this.idleWaiters.get(id) ?? [];
      list.push(res);
      this.idleWaiters.set(id, list);
    });
  }

  /** Stop sending queued messages to this agent until release(). Messages keep queueing. */
  hold(id: string): void { this.held.add(id); const a = this.agents.get(id); if (a) this.emitAgent(a); }
  release(id: string): void { this.held.delete(id); const a = this.agents.get(id); if (a) { this.emitAgent(a); this.pump(id); } }

  /**
   * Swap in a warmed-up process (new Claude session) for an agent. The old
   * process, if any, is ended quietly. Identity, feed, queue and name are kept.
   */
  adopt(id: string, proc: ClaudeProcess, sessionId: string, stats: { contextTokens: number; sessionTokens: number }): void {
    const a = this.get(id);
    const old = this.live.get(id);
    if (old) {
      old.ending = 'sleep';
      this.live.delete(id); // detach first so its exit is ignored
      old.proc.endInput();
      setTimeout(() => old.proc.kill('SIGTERM'), 5000).unref();
    }
    if (a.sessionId) this.store.endSession(a.sessionId, 'rotated');
    a.generation += 1;
    a.sessionId = sessionId;
    this.store.insertSession(sessionId, a.id, a.generation);
    this.store.markSessionInitialized(sessionId);
    a.contextTokens = stats.contextTokens;
    a.sessionTokens = stats.sessionTokens;
    a.compactions = 0;
    a.status = 'idle';
    a.lastError = null;
    this.crashes.delete(id);
    proc.removeAllListeners('line');
    proc.removeAllListeners('exit');
    this.attach(a, proc, true);
    this.store.setLivePid(id, proc.pid);
    this.store.saveAgent(a);
    this.armIdle(id);
    this.emitAgent(a);
  }

  /** Append a feed item on behalf of another subsystem (rotation dividers, notices). */
  postFeed(id: string, item: FeedItem): void { this.addFeed(this.get(id), item); }

  /** Feed items newer than `since` (for journalist / handoff transcripts). */
  feedSince(id: string, since: number, limit = 400): FeedItem[] {
    return this.store.feedPage(id, null, limit).items.filter((i) => i.ts > since);
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
        const images = act.images?.length ? this.images.save(a.id, act.images) : [];
        this.addFeed(a, { ...item, status: act.isError ? 'error' : 'ok', result: act.content,
          durationMs: started ? act.ts - started : undefined, ...(images.length ? { images } : {}) });
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
      isError: act.isError && !interrupted, interrupted, inputs: inputs.map(({ text, author }) => ({ text, author })),
      freshTokens: fresh, startedAt: live.turnStartedAt,
      messageIds: inputs.flatMap((m) => (m.id ? [m.id] : [])), // [core2]
    };
    try { this.emit('turn-end', ev); } catch (e) { console.error('[runtime] turn-end listener failed', e); }
    this.flushIdleWaiters(a.id);
    if (live.recycle && this.live.get(a.id) === live) {
      // New model/effort/instructions take effect now; queued messages go to the fresh process (onExit pumps).
      void this.endProcess(a.id, 'sleep');
      return;
    }
    this.pump(a.id);
    if (!live.turnActive) this.armIdle(a.id);
  }

  private flushIdleWaiters(id: string): void {
    const w = this.idleWaiters.get(id);
    if (!w) return;
    this.idleWaiters.delete(id);
    for (const fn of w) fn();
  }

  private onExit(id: string, live: Live, code: number | null, signal: string | null): void {
    if (this.live.get(id) !== live) return;
    this.live.delete(id);
    this.flushIdleWaiters(id);
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
    this.emit('gone', { agentId: a.id, reason: 'error' } satisfies GoneEvent); // [core2]
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
