import type { Agent, AskRes, ChatThread, ChatTurn, ChatTurnKind, PeerServer, RelayEnvelope, TellRes, WhoEntry, WhoRes } from '@axo/protocol';
import type { Store } from '../store/db.ts';
import type { EventBus } from '../events.ts';
import type { AgentRuntime, DeliverEvent, GoneEvent, TurnEndEvent } from '../runtime/agent-runtime.ts';
import { ulid } from '../util/ulid.ts';
import { HttpError } from '../util/http-error.ts';

/**
 * Loop breaker, not a quota: every message is delivered unless a pair exchanges more than
 * LOOP_LIMIT messages within LOOP_WINDOW_MS with no user message to either agent. That pattern
 * is two agents ping-ponging unattended; the pair is paused until the user steps in or it goes quiet.
 */
export const LOOP_LIMIT = 20;
export const LOOP_WINDOW_MS = 10 * 60_000;
/** @deprecated kept for callers/tests; the limit is now rate-based (see LOOP_LIMIT). */
export const MAX_EXCHANGES = LOOP_LIMIT;
/** Feed text prefix the UI keys its "pair paused" notification on. */
export const LOOP_PAUSE_PREFIX = 'InnerChat paused:';
/** `axo ask` runs inside Claude's Bash tool (default timeout 2 min), so stay under it by default. */
export const DEFAULT_ASK_TIMEOUT_MS = 110_000;
/** Bash allows up to 10 min with an explicit timeout. */
export const MAX_ASK_TIMEOUT_MS = 570_000;
/** How long a tell (or a timed-out ask) keeps listening for its reply. */
const ASYNC_REPLY_MS = 6 * 60 * 60_000;
/** A thread idle this long is closed; the next message starts a fresh one (and a fresh cap). */
const THREAD_IDLE_MS = 30 * 60_000;
const THREAD_HISTORY_MS = 7 * 24 * 60 * 60_000;
/** Relayed envelopes the app hasn't delivered by then fail (the sender is told). */
const OUTBOX_EXPIRE_MS = 24 * 60 * 60_000;

/** A conversation partner: a local agent, or a remote one (`remote:<name>@<server>`). */
interface Party { id: string; name: string; role?: string; projectId?: string }

interface Pending {
  msgId: string;           // the feed/message id the runtime reports in 'turn-end'
  targetId: string;
  senderId: string;
  threadId: string;
  mode: 'block' | 'async';
  timer: NodeJS.Timeout;
  settle?: (r: { text: string } | { error: string } | { timedOut: true }) => void;
  /** Target side of a relayed message: the answer goes to the outbox, addressed back to the origin. */
  relay?: { replyTo: string; toServer: string; sender: Party };
}

/** Origin side of a relayed ask/tell, keyed by envelope id. */
interface RemotePending {
  envId: string;
  senderId: string;
  threadId: string;
  remote: Party;
  kind: 'ask' | 'tell';
  timer: NodeJS.Timeout;
  settle?: (r: { text: string } | { error: string } | { timedOut: true }) => void;
}

/**
 * Agent-to-agent messaging. Ported from Groove's innerchat.js, minus federation, with:
 * - exact reply matching: the runtime reports which message ids a turn consumed, so an answer is
 *   the final text of the turn that read the question (no counting results to skip);
 * - threads persisted in SQLite; a thread closes after 30 min idle or when the user messages
 *   either agent; a rate-based loop breaker (LOOP_LIMIT per LOOP_WINDOW_MS) pauses runaway pairs
 *   instead of a lifetime cap, so normal coordination is never blocked;
 * - sender identity from the caller's agent token, never from the request body;
 * - deadlock guard that follows the whole blocked-on chain (A→B→C→A), not just direct pairs.
 */
export class InnerChat {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly runtime: AgentRuntime;
  private readonly pending = new Map<string, Pending[]>(); // by targetId
  private readonly blockedOn = new Map<string, string>();  // askerId → targetId
  private readonly remotePending = new Map<string, RemotePending>(); // by envelope id
  private readonly pausedNotified = new Set<string>();     // thread ids whose loop pause was already surfaced
  private stopped = false;
  /** Servers the app knows (PUT /innerchat/peers). null until the app has told us: then any @server is queued. */
  private peers: PeerServer[] | null = null;
  private readonly expiry: NodeJS.Timeout;

  constructor(store: Store, bus: EventBus, runtime: AgentRuntime) {
    this.store = store;
    this.bus = bus;
    this.runtime = runtime;
    runtime.on('turn-end', (e: TurnEndEvent) => this.onTurnEnd(e));
    runtime.on('gone', (e: GoneEvent) => this.onGone(e));
    runtime.on('deliver', (e: DeliverEvent) => { if (e.author === 'user') this.closeThreadsOf(e.agentId); });
    this.pruneThreads();
    this.expiry = setInterval(() => this.expireOutbox(), 10 * 60_000);
    this.expiry.unref();
  }

  // ── addressing ───────────────────────────────────────────

  /** `name`, `name@team`, or an agent id, within the sender's project. */
  resolve(from: Agent, ref: string): Agent {
    const r = ref.trim();
    if (!r) throw new HttpError(400, 'who should get this? pass an agent name (see `axo who`)');
    const pool = this.runtime.list().filter((a) => a.projectId === from.projectId);
    const [name, where] = r.split('@');
    let hits: Agent[];
    if (where !== undefined) {
      const team = this.store.listTeams().find((t) => t.projectId === from.projectId && !t.archivedAt
        && t.name.toLowerCase() === where.toLowerCase());
      if (!team) throw new HttpError(404, `no team "${where}" in this project`);
      hits = pool.filter((a) => a.teamId === team.id && a.name.toLowerCase() === name.toLowerCase());
    } else {
      hits = pool.filter((a) => a.id === r || a.name === r);
      if (!hits.length) hits = pool.filter((a) => a.name.toLowerCase() === r.toLowerCase());
    }
    if (!hits.length) {
      const names = pool.filter((a) => a.id !== from.id).map((a) => a.name);
      throw new HttpError(404, `no agent named "${r}" in this project. ${names.length ? `Agents you can reach: ${names.join(', ')}.` : 'There are no other agents in this project.'}`);
    }
    return hits[0];
  }

  who(callerId: string | null, projectId?: string): WhoRes {
    const me = callerId ? this.runtime.get(callerId) : null;
    const pid = me?.projectId ?? projectId;
    const teams = new Map(this.store.listTeams().map((t) => [t.id, t]));
    const agents: WhoEntry[] = this.runtime.list()
      .filter((a) => !pid || a.projectId === pid)
      .filter((a) => !teams.get(a.teamId)?.archivedAt)
      .map((a) => ({ id: a.id, name: a.name, role: a.role, team: teams.get(a.teamId)?.name ?? '?', status: a.status,
        scope: a.scopeGlobs, you: a.id === callerId }));
    return { you: me?.name ?? null, agents, ...(this.peers ? { servers: this.peers } : {}) };
  }

  // ── ask / tell ───────────────────────────────────────────

  /**
   * Deliver a question and wait for the answer. On timeout (or if the caller disconnects) the
   * question stays open and a late answer is delivered to the asker as a normal message.
   */
  ask(fromId: string, toRef: string, message: string, timeoutMs = DEFAULT_ASK_TIMEOUT_MS, onAbort?: (cancel: () => void) => void): Promise<AskRes> {
    const from = this.runtime.get(fromId);
    const remote = this.remoteRef(from, toRef);
    if (remote) return this.remoteSend(from, remote, message, 'ask', timeoutMs, onAbort) as Promise<AskRes>;
    const to = this.resolve(from, toRef);
    const text = this.validate(from, to, message);
    this.checkDeadlock(from, to);
    const thread = this.openThread(from, to);
    const msgId = this.send(thread, from, to, text, 'ask');
    const remaining = this.remaining(thread);
    const wait = Math.min(Math.max(Number(timeoutMs) || DEFAULT_ASK_TIMEOUT_MS, 1000), MAX_ASK_TIMEOUT_MS);

    return new Promise<AskRes>((resolve) => {
      const p: Pending = { msgId, targetId: to.id, senderId: from.id, threadId: thread.id, mode: 'block', timer: null as any };
      const toAsync = () => {
        // Keep listening: the answer will come as a message instead of being dropped.
        clearTimeout(p.timer);
        p.mode = 'async';
        p.settle = undefined;
        p.timer = setTimeout(() => this.drop(p), ASYNC_REPLY_MS);
        p.timer.unref();
        if (this.blockedOn.get(from.id) === to.id) this.blockedOn.delete(from.id);
      };
      p.settle = (r) => {
        clearTimeout(p.timer);
        if (this.blockedOn.get(from.id) === to.id) this.blockedOn.delete(from.id);
        if ('text' in r) {
          this.drop(p);
          resolve({ reply: r.text, timedOut: false, threadId: thread.id, exchangesRemaining: remaining });
        } else if ('error' in r) {
          this.drop(p);
          resolve({ reply: null, timedOut: false, note: r.error, threadId: thread.id, exchangesRemaining: remaining });
        } else {
          toAsync();
          resolve({
            reply: null, timedOut: true, threadId: thread.id, exchangesRemaining: remaining,
            note: `No answer from ${to.name} within ${Math.round(wait / 1000)}s; it is probably mid-task. `
              + 'Carry on with other work: its answer will be delivered to you as a message when it comes.',
          });
        }
      };
      p.timer = setTimeout(() => p.settle?.({ timedOut: true }), wait);
      p.timer.unref();
      this.addPending(p);
      this.blockedOn.set(from.id, to.id);
      onAbort?.(() => { if (p.mode === 'block') toAsync(); });
    });
  }

  /** Deliver without waiting. If the target replies, the reply is delivered back to the sender. */
  tell(fromId: string, toRef: string, message: string): TellRes {
    const from = this.runtime.get(fromId);
    const remote = this.remoteRef(from, toRef);
    if (remote) return this.remoteSend(from, remote, message, 'tell') as TellRes;
    const to = this.resolve(from, toRef);
    const text = this.validate(from, to, message);
    const thread = this.openThread(from, to);
    const msgId = this.send(thread, from, to, text, 'tell');
    const p: Pending = { msgId, targetId: to.id, senderId: from.id, threadId: thread.id, mode: 'async', timer: null as any };
    p.timer = setTimeout(() => this.drop(p), ASYNC_REPLY_MS);
    p.timer.unref();
    this.addPending(p);
    return { delivered: true, threadId: thread.id, exchangesRemaining: this.remaining(thread) };
  }

  // ── queries ──────────────────────────────────────────────

  threads(agentId?: string): ChatThread[] {
    const rows = (agentId
      ? this.store.db.prepare('SELECT * FROM ic_threads WHERE a_id = ? OR b_id = ? ORDER BY updated_at DESC LIMIT 200').all(agentId, agentId)
      : this.store.db.prepare('SELECT * FROM ic_threads ORDER BY updated_at DESC LIMIT 200').all()) as Record<string, any>[];
    return rows.map(toThread);
  }

  turns(threadId: string): ChatTurn[] {
    return (this.store.db.prepare('SELECT * FROM ic_turns WHERE thread_id = ? ORDER BY ts, id').all(threadId) as Record<string, any>[])
      .map(toTurn);
  }

  /** Release blocked asks (node shutdown). Late turn-ends are ignored so nothing respawns an agent. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.expiry);
    for (const r of [...this.remotePending.values()]) {
      if (r.settle) r.settle({ error: 'The Axo node is shutting down; ask again once it is back.' });
      else this.dropRemote(r);
    }
    for (const list of this.pending.values()) {
      for (const p of [...list]) {
        if (p.settle) p.settle({ error: 'The Axo node is shutting down; ask again once it is back.' });
        else this.drop(p);
      }
    }
  }

  // ── internals ────────────────────────────────────────────

  private validate(from: Party, to: Party, message: string): string {
    if (from.id === to.id) throw new HttpError(400, 'you cannot message yourself');
    const text = String(message ?? '').trim();
    if (!text) throw new HttpError(400, 'message is empty');
    if (text.length > 32_000) throw new HttpError(413, 'message too long (32k chars max); put details in a file and send the path');
    return text;
  }

  private checkDeadlock(from: Agent, to: Agent): void {
    const seen = new Set<string>();
    for (let cur = to.id; this.blockedOn.has(cur) && !seen.has(cur);) {
      seen.add(cur);
      cur = this.blockedOn.get(cur)!;
      if (cur === from.id) {
        const direct = this.blockedOn.get(to.id) === from.id;
        throw new HttpError(409, direct
          ? `${to.name} is blocked waiting for YOUR answer, so it can't read a new question until you reply. Answer its question first (just reply in your message); that is what unblocks it.`
          : `${to.name} is (indirectly) waiting on you, so asking it would deadlock. Answer the question you were asked first, or use \`axo tell\`.`);
      }
    }
  }

  /** Open thread for this pair, or a new one. Throws when the pair is looping (see LOOP_LIMIT). */
  private openThread(from: Party & { projectId: string }, to: Party): ChatThread {
    const [a, b] = [from, to].sort((x, y) => (x.id < y.id ? -1 : 1));
    const row = this.store.db.prepare(`SELECT * FROM ic_threads WHERE a_id = ? AND b_id = ? AND status != 'closed'
      ORDER BY updated_at DESC LIMIT 1`).get(a.id, b.id) as Record<string, any> | undefined;
    if (row && Date.now() - row.updated_at < THREAD_IDLE_MS) {
      const t = toThread(row);
      const recent = this.recentExchanges(t.id);
      if (recent >= LOOP_LIMIT) {
        if (!this.pausedNotified.has(t.id)) {
          this.pausedNotified.add(t.id);
          this.runtime.postFeed(from.id, { kind: 'system', level: 'warn', id: `ic-${ulid()}`, ts: Date.now(),
            text: `${LOOP_PAUSE_PREFIX} ${from.name} and ${to.name} exchanged ${recent} messages in ${Math.round(LOOP_WINDOW_MS / 60_000)} minutes without you, so they're paused. Message either agent to let them continue.` });
        }
        throw new HttpError(429, `Paused: you and ${to.name} have exchanged ${recent} messages in the last ${Math.round(LOOP_WINDOW_MS / 60_000)} minutes without the user stepping in, which looks like a loop. Stop messaging ${to.name}, summarize where things stand for the user, and wait. This clears when the user messages either of you, or after a few quiet minutes.`);
      }
      this.pausedNotified.delete(t.id);
      return t;
    }
    if (row) this.store.db.prepare(`UPDATE ic_threads SET status = 'closed' WHERE id = ?`).run(row.id);
    const now = Date.now();
    const id = ulid();
    this.store.db.prepare(`INSERT INTO ic_threads (id, project_id, a_id, a_name, b_id, b_name, status, exchanges, created_at, updated_at)
      VALUES (?,?,?,?,?,?,'open',0,?,?)`).run(id, from.projectId, a.id, a.name, b.id, b.name, now, now);
    return toThread(this.store.db.prepare('SELECT * FROM ic_threads WHERE id = ?').get(id) as Record<string, any>);
  }

  /** Record + deliver an ask/tell. Returns the runtime message id. */
  private send(thread: ChatThread, from: Agent, to: Agent, text: string, kind: 'ask' | 'tell'): string {
    const msgId = this.runtime.deliver(to.id, wrap(from, text, kind), from.name);
    this.bump(thread);
    this.runtime.postFeed(from.id, { kind: 'user', id: `ic-${ulid()}`, ts: Date.now(), author: from.name,
      text: `[${kind} → ${to.name}] ${text}` });
    this.record(thread.id, from, to, kind, text);
    return msgId;
  }

  /** Ask/tell messages in this thread within the loop window. */
  private recentExchanges(threadId: string): number {
    const r = this.store.db.prepare(`SELECT COUNT(*) AS n FROM ic_turns WHERE thread_id = ? AND kind IN ('ask','tell') AND ts > ?`)
      .get(threadId, Date.now() - LOOP_WINDOW_MS) as { n: number };
    return r.n;
  }
  private remaining(thread: ChatThread): number { return Math.max(0, LOOP_LIMIT - this.recentExchanges(thread.id)); }

  private bump(thread: ChatThread): void {
    thread.exchanges++;
    this.store.db.prepare(`UPDATE ic_threads SET exchanges = ?, status = 'awaiting', updated_at = ? WHERE id = ?`)
      .run(thread.exchanges, Date.now(), thread.id);
  }

  private onTurnEnd(e: TurnEndEvent): void {
    if (this.stopped) return;
    const list = this.pending.get(e.agentId);
    const ids = e.messageIds ?? [];
    if (!list?.length || !ids.length) return;
    for (const p of list.filter((x) => ids.includes(x.msgId))) {
      const text = e.lastText.trim();
      if (text) { this.answer(p, text); continue; }
      const responder = this.store.getAgent(e.agentId)?.name ?? 'the agent';
      const why = `${responder} ${e.interrupted ? 'was interrupted' : 'ended its turn'} without answering.`;
      if (p.relay) this.relayFailure(p, why);
      else if (p.settle) p.settle({ error: why });
      else this.drop(p);
    }
  }

  private answer(p: Pending, text: string): void {
    if (p.relay) { this.relayAnswer(p, text); return; }
    const responder = this.store.getAgent(p.targetId);
    const sender = this.store.getAgent(p.senderId);
    if (!responder || !sender) { p.settle ? p.settle({ error: 'the conversation partner was deleted' }) : this.drop(p); return; }
    this.store.db.prepare(`UPDATE ic_threads SET status = 'open', updated_at = ? WHERE id = ? AND status != 'closed'`)
      .run(Date.now(), p.threadId);
    this.record(p.threadId, responder, sender, 'answer', text);
    if (p.settle) {
      this.runtime.postFeed(sender.id, { kind: 'user', id: `ic-${ulid()}`, ts: Date.now(), author: responder.name, text });
      p.settle({ text });
      return;
    }
    this.drop(p);
    try {
      this.runtime.deliver(sender.id, [
        `[InnerChat reply from ${responder.name} (${responder.role})]`, '', text, '',
        'This answers a message you sent earlier (you were not blocked on it). Fold it into your work, or reply again to continue.',
      ].join('\n'), responder.name);
    } catch { /* sender deleted meanwhile */ }
  }

  private onGone(e: GoneEvent): void {
    const name = this.store.getAgent(e.agentId)?.name ?? 'the agent';
    const why = e.reason === 'stop' ? 'was stopped' : e.reason === 'delete' ? 'was deleted' : 'hit an error';
    for (const p of [...(this.pending.get(e.agentId) ?? [])]) {
      if (p.relay) this.relayFailure(p, `${name} ${why} before answering.`);
      else if (p.settle) p.settle({ error: `${name} ${why} before answering.` });
      else this.drop(p);
    }
  }

  private closeThreadsOf(agentId: string): void {
    this.store.db.prepare(`UPDATE ic_threads SET status = 'closed' WHERE (a_id = ? OR b_id = ?) AND status != 'closed' AND exchanges > 0`)
      .run(agentId, agentId);
  }

  private record(threadId: string, from: Party, to: Party, kind: ChatTurnKind, text: string): void {
    const turn: ChatTurn = { id: ulid(), threadId, fromId: from.id, fromName: from.name, toId: to.id, toName: to.name, kind, text, ts: Date.now() };
    this.store.db.prepare(`INSERT INTO ic_turns (id, thread_id, from_id, from_name, to_id, to_name, kind, text, ts) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(turn.id, threadId, from.id, from.name, to.id, to.name, kind, text, turn.ts);
    const thread = toThread(this.store.db.prepare('SELECT * FROM ic_threads WHERE id = ?').get(threadId) as Record<string, any>);
    this.bus.publish({ type: 'innerchat:turn', thread, turn });
  }

  // ── cross-server relay (name@server) ─────────────────────

  /** `name@x` where x is not a team in the sender's project: a remote address for the app to relay. */
  private remoteRef(from: Agent, ref: string): { name: string; server: string } | null {
    const m = /^([^@\s]+)@([^@\s]+)$/.exec(ref.trim());
    if (!m) return null;
    const isTeam = this.store.listTeams().some((t) => t.projectId === from.projectId && !t.archivedAt && t.name.toLowerCase() === m[2].toLowerCase());
    if (isTeam) return null;
    return { name: m[1], server: this.resolveServer(m[2]) };
  }

  setPeers(servers: unknown): void {
    if (!Array.isArray(servers)) throw new HttpError(400, 'servers[] required');
    this.peers = servers
      .filter((s) => s && typeof s.id === 'string' && s.id)
      .map((s) => ({ id: String(s.id), name: String(s.name ?? s.id), connected: !!s.connected }));
  }

  /** The app's server id for an alias the agent typed (ids first, then names). Unknown → 404 once the app has sent its list. */
  private resolveServer(alias: string): string {
    if (!this.peers) return alias; // the app hasn't told us yet; it will resolve (or reject) the alias itself
    const a = alias.toLowerCase();
    const byId = this.peers.find((s) => s.id.toLowerCase() === a);
    if (byId) return byId.id;
    const byName = this.peers.filter((s) => s.name.toLowerCase() === a);
    if (byName.length === 1) return byName[0].id;
    const known = this.peers.map((s) => s.id).join(', ') || 'none';
    if (byName.length > 1) throw new HttpError(409, `server name "${alias}" is ambiguous; use one of these ids: ${byName.map((s) => s.id).join(', ')}`);
    throw new HttpError(404, `no team or server named "${alias}". Servers: ${known} (see \`axo who\`).`);
  }

  private remoteSend(from: Agent, to: { name: string; server: string }, message: string, kind: 'ask' | 'tell',
    timeoutMs = DEFAULT_ASK_TIMEOUT_MS, onAbort?: (cancel: () => void) => void): Promise<AskRes> | TellRes {
    const remote: Party = { id: `remote:${to.name}@${to.server}`, name: `${to.name}@${to.server}` };
    const text = this.validate(from, remote, message);
    const thread = this.openThread(from, remote);
    this.bump(thread);
    const env = this.enqueue({ kind, from, toServer: to.server, toAgent: to.name, replyTo: null, text, error: null });
    this.runtime.postFeed(from.id, { kind: 'user', id: `ic-${ulid()}`, ts: Date.now(), author: from.name, text: `[${kind} → ${remote.name}] ${text}` });
    this.record(thread.id, from, remote, kind, text);
    const remaining = this.remaining(thread);
    const r: RemotePending = { envId: env.id, senderId: from.id, threadId: thread.id, remote, kind, timer: null as any };
    this.remotePending.set(env.id, r);
    if (kind === 'tell') {
      r.timer = setTimeout(() => this.dropRemote(r), OUTBOX_EXPIRE_MS);
      r.timer.unref();
      const offline = this.peers?.find((p) => p.id === to.server)?.connected === false;
      return { delivered: true, threadId: thread.id, exchangesRemaining: remaining, remote: true, ...(offline ? { queued: true } : {}) };
    }
    const wait = Math.min(Math.max(Number(timeoutMs) || DEFAULT_ASK_TIMEOUT_MS, 1000), MAX_ASK_TIMEOUT_MS);
    return new Promise<AskRes>((resolve) => {
      const toAsync = () => {
        clearTimeout(r.timer);
        r.settle = undefined;
        r.timer = setTimeout(() => this.dropRemote(r), OUTBOX_EXPIRE_MS);
        r.timer.unref();
      };
      r.settle = (res) => {
        clearTimeout(r.timer);
        if ('timedOut' in res) {
          toAsync();
          resolve({ reply: null, timedOut: true, threadId: thread.id, exchangesRemaining: remaining,
            note: `No answer from ${remote.name} within ${Math.round(wait / 1000)}s (it may be busy, or the Axo app may be closed and unable to relay). Carry on: the answer will be delivered to you as a message when it comes.` });
          return;
        }
        this.dropRemote(r);
        resolve('text' in res
          ? { reply: res.text, timedOut: false, threadId: thread.id, exchangesRemaining: remaining }
          : { reply: null, timedOut: false, note: res.error, threadId: thread.id, exchangesRemaining: remaining });
      };
      r.timer = setTimeout(() => r.settle?.({ timedOut: true }), wait);
      r.timer.unref();
      onAbort?.(() => { if (r.settle) toAsync(); });
    });
  }

  /** Pending envelopes for the app to relay (oldest first). */
  outbox(): RelayEnvelope[] {
    this.expireOutbox();
    return (this.store.db.prepare(`SELECT * FROM ic_outbox WHERE status = 'pending' ORDER BY created_at, id LIMIT 500`).all() as Record<string, any>[])
      .map(toEnvelope);
  }

  /** The app reports whether it delivered an envelope. A failure is passed on to the sender. */
  ack(id: string, ok: boolean, error?: string): void {
    const row = this.store.db.prepare('SELECT * FROM ic_outbox WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!row) throw new HttpError(404, 'no such outbox entry');
    if (row.status !== 'pending') return;
    this.store.db.prepare('UPDATE ic_outbox SET status = ?, fail_reason = ?, updated_at = ? WHERE id = ?')
      .run(ok ? 'delivered' : 'failed', ok ? null : (error ?? 'unknown error'), Date.now(), id);
    if (!ok) this.relayUndeliverable(toEnvelope(row), error ?? 'unknown error');
  }

  /** An envelope from another node, delivered by the app. */
  relayIn(env: RelayEnvelope, fromServer: string): { ok: true } {
    if (!env || typeof env !== 'object' || !env.id || !env.from?.name || !fromServer) throw new HttpError(400, 'envelope and fromServer required');
    // Idempotent: the app may crash between relay-in and ack and send the same envelope again.
    if (this.store.db.prepare('SELECT 1 FROM ic_inbox WHERE from_server = ? AND envelope_id = ?').get(fromServer, env.id)) return { ok: true };
    const res = this.receive(env, fromServer);
    this.store.db.prepare('INSERT OR IGNORE INTO ic_inbox (from_server, envelope_id, received_at) VALUES (?,?,?)').run(fromServer, env.id, Date.now());
    return res;
  }

  private receive(env: RelayEnvelope, fromServer: string): { ok: true } {
    const sender: Party = { id: `remote:${env.from.name}@${fromServer}`, name: `${env.from.name}@${fromServer}`, role: env.from.role || 'agent' };
    if (env.kind === 'answer') {
      let r = env.replyTo ? this.remotePending.get(env.replyTo) : undefined;
      if (!r) {
        // Nothing waiting in memory (node restarted, or the wait expired): route it from the outbox record.
        const orig = env.replyTo ? this.store.db.prepare('SELECT * FROM ic_outbox WHERE id = ?').get(env.replyTo) as Record<string, any> | undefined : undefined;
        if (!orig || !this.store.getAgent(orig.from_agent_id)) return { ok: true };
        const thread = this.store.db.prepare('SELECT id FROM ic_threads WHERE (a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?) ORDER BY updated_at DESC LIMIT 1')
          .get(orig.from_agent_id, sender.id, sender.id, orig.from_agent_id) as { id: string } | undefined;
        if (!thread) return { ok: true };
        r = { envId: orig.id, senderId: orig.from_agent_id, threadId: thread.id, remote: sender, kind: orig.kind, timer: setTimeout(() => {}, 0) };
      }
      this.store.db.prepare(`UPDATE ic_threads SET status = 'open', updated_at = ? WHERE id = ? AND status != 'closed'`).run(Date.now(), r.threadId);
      const local = this.store.getAgent(r.senderId);
      if (env.error) {
        if (r.settle) r.settle({ error: env.error });
        else { this.dropRemote(r); if (local) this.notify(local, `${sender.name} could not answer your message: ${env.error}`); }
        return { ok: true };
      }
      if (local) this.record(r.threadId, sender, local, 'answer', env.text);
      if (r.settle) {
        if (local) this.runtime.postFeed(local.id, { kind: 'user', id: `ic-${ulid()}`, ts: Date.now(), author: sender.name, text: env.text });
        r.settle({ text: env.text });
      } else {
        this.dropRemote(r);
        if (local) {
          try {
            this.runtime.deliver(local.id, [`[InnerChat reply from ${sender.name} (${sender.role})]`, '', env.text, '',
              'This answers a message you sent earlier (you were not blocked on it). Fold it into your work, or reply again to continue.'].join('\n'), sender.name);
          } catch { /* deleted meanwhile */ }
        }
      }
      return { ok: true };
    }
    if (env.kind !== 'ask' && env.kind !== 'tell') throw new HttpError(400, `bad envelope kind ${env.kind}`);
    const target = this.findLocal(String(env.toAgent ?? ''));
    const text = this.validate(sender, target, env.text);
    const thread = this.openThread(target, sender);
    const msgId = this.runtime.deliver(target.id, wrap(sender, text, env.kind), sender.name);
    this.bump(thread);
    this.record(thread.id, sender, target, env.kind, text);
    const p: Pending = { msgId, targetId: target.id, senderId: sender.id, threadId: thread.id, mode: 'async', timer: null as any,
      relay: { replyTo: env.id, toServer: fromServer, sender } };
    p.timer = setTimeout(() => this.drop(p), ASYNC_REPLY_MS);
    p.timer.unref();
    this.addPending(p);
    return { ok: true };
  }

  /** Target lookup for relayed messages: names are unique per project, so search the whole node. */
  private findLocal(name: string): Agent {
    const teams = new Map(this.store.listTeams().map((t) => [t.id, t]));
    const live = this.runtime.list().filter((a) => !teams.get(a.teamId)?.archivedAt);
    let hits = live.filter((a) => a.name === name);
    if (!hits.length) hits = live.filter((a) => a.name.toLowerCase() === name.toLowerCase());
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new HttpError(404, `no agent named "${name}" on this server. Agents here: ${live.map((a) => a.name).join(', ') || 'none'}.`);
    const projects = hits.map((a) => this.store.getProject(a.projectId)?.name ?? a.projectId);
    throw new HttpError(409, `"${name}" is ambiguous on this server (projects: ${projects.join(', ')}).`);
  }

  private relayAnswer(p: Pending, text: string): void {
    const responder = this.store.getAgent(p.targetId);
    this.drop(p);
    if (!responder || !p.relay) return;
    this.store.db.prepare(`UPDATE ic_threads SET status = 'open', updated_at = ? WHERE id = ? AND status != 'closed'`).run(Date.now(), p.threadId);
    this.record(p.threadId, responder, p.relay.sender, 'answer', text);
    this.enqueue({ kind: 'answer', from: responder, toServer: p.relay.toServer, toAgent: null, replyTo: p.relay.replyTo, text, error: null });
  }

  private relayFailure(p: Pending, why: string): void {
    const responder = this.store.getAgent(p.targetId);
    this.drop(p);
    if (!responder || !p.relay) return;
    this.enqueue({ kind: 'answer', from: responder, toServer: p.relay.toServer, toAgent: null, replyTo: p.relay.replyTo, text: '', error: why });
  }

  /** The app couldn't deliver one of our envelopes (or it expired). */
  private relayUndeliverable(env: RelayEnvelope, error: string): void {
    if (env.kind === 'answer') return; // the asker's own timeout covers it
    const r = this.remotePending.get(env.id);
    const where = `${env.toAgent}@${env.toServer}`;
    if (r?.settle) { r.settle({ error: `Could not reach ${where}: ${error}` }); return; }
    if (r) this.dropRemote(r);
    const local = this.store.getAgent(env.from.agentId);
    if (local) this.notify(local, `Your message to ${where} could not be delivered: ${error}`);
  }

  private notify(agent: Agent, text: string): void {
    try { this.runtime.deliver(agent.id, `[InnerChat] ${text}`, 'axo'); } catch { /* gone */ }
  }

  private enqueue(e: Omit<RelayEnvelope, 'id' | 'createdAt' | 'from'> & { from: Agent }): RelayEnvelope {
    const env: RelayEnvelope = { ...e, id: ulid(), from: { agentId: e.from.id, name: e.from.name, role: e.from.role }, createdAt: Date.now() };
    this.store.db.prepare(`INSERT INTO ic_outbox (id, kind, from_agent_id, from_name, from_role, to_server, to_agent, reply_to, text, error,
      status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
      .run(env.id, env.kind, env.from.agentId, env.from.name, env.from.role, env.toServer, env.toAgent, env.replyTo, env.text, env.error, env.createdAt, env.createdAt);
    this.bus.publish({ type: 'innerchat:outbox', envelope: env });
    return env;
  }

  private expireOutbox(): void {
    const cutoff = Date.now() - OUTBOX_EXPIRE_MS;
    const old = this.store.db.prepare(`SELECT * FROM ic_outbox WHERE status = 'pending' AND created_at < ?`).all(cutoff) as Record<string, any>[];
    for (const row of old) this.ack(row.id, false, 'not relayed within 24h (is the Axo app running and connected to that server?)');
    this.store.db.prepare(`DELETE FROM ic_outbox WHERE status != 'pending' AND updated_at < ?`).run(Date.now() - THREAD_HISTORY_MS);
    this.store.db.prepare('DELETE FROM ic_inbox WHERE received_at < ?').run(Date.now() - THREAD_HISTORY_MS);
  }

  private dropRemote(r: RemotePending): void {
    clearTimeout(r.timer);
    this.remotePending.delete(r.envId);
  }

  private addPending(p: Pending): void {
    const list = this.pending.get(p.targetId);
    if (list) list.push(p); else this.pending.set(p.targetId, [p]);
  }
  private drop(p: Pending): void {
    clearTimeout(p.timer);
    const list = this.pending.get(p.targetId);
    if (!list) return;
    const i = list.indexOf(p);
    if (i !== -1) list.splice(i, 1);
    if (!list.length) this.pending.delete(p.targetId);
  }

  private pruneThreads(): void {
    this.store.db.prepare('DELETE FROM ic_threads WHERE updated_at < ?').run(Date.now() - THREAD_HISTORY_MS);
  }
}

function wrap(from: Party, text: string, kind: 'ask' | 'tell'): string {
  const header = kind === 'ask'
    ? `[InnerChat: ${from.name} (${from.role}) is asking you a question]`
    : `[InnerChat: ${from.name} (${from.role}) sent you a message]`;
  const footer = kind === 'ask'
    ? `${from.name} is BLOCKED waiting for your answer. Answer directly and concisely in this turn; your final message is sent back to it verbatim. Do not address the user and do not start unrelated work first.`
    : `${from.name} is not blocked. Finish what you are doing first if you are mid-task; your final message this turn is relayed back to ${from.name}.`;
  return [header, '', text, '', footer].join('\n');
}

function toThread(r: Record<string, any>): ChatThread {
  return {
    id: r.id, projectId: r.project_id, participants: [{ id: r.a_id, name: r.a_name }, { id: r.b_id, name: r.b_name }],
    exchanges: r.exchanges, maxExchanges: LOOP_LIMIT, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function toEnvelope(r: Record<string, any>): RelayEnvelope {
  return {
    id: r.id, kind: r.kind, from: { agentId: r.from_agent_id, name: r.from_name, role: r.from_role }, toServer: r.to_server,
    toAgent: r.to_agent, replyTo: r.reply_to, text: r.text, error: r.error, createdAt: r.created_at,
  };
}
function toTurn(r: Record<string, any>): ChatTurn {
  return { id: r.id, threadId: r.thread_id, fromId: r.from_id, fromName: r.from_name, toId: r.to_id, toName: r.to_name, kind: r.kind, text: r.text, ts: r.ts };
}
