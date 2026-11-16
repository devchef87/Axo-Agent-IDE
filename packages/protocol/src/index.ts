// Axo wire protocol — shared by core (node), ui, app and cli.
// Types only: always `import type` from here so nothing is loaded at runtime.

export const PROTOCOL_VERSION = 1;

// ── Entities ────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  path: string;
  isGit: boolean;
  baseBranch: string | null;
  setupCmd: string | null;
  createdAt: number;
}

export type TeamMode = 'worktree' | 'shared' | 'direct';

export interface Team {
  id: string;
  projectId: string;
  name: string;
  mode: TeamMode;
  branch: string | null;
  worktreePath: string | null;
  createdAt: number;
  archivedAt: number | null;
}

export type AgentStatus =
  | 'asleep'    // no process; resumable on next message
  | 'starting'  // process spawned, first turn not started yet
  | 'idle'      // process alive, waiting for input
  | 'working'   // mid-turn
  | 'rotating'  // hot-swap in progress
  | 'error'     // crash loop or unrecoverable; user action needed
  | 'stopped';  // user stopped it; stays in team until deleted

export interface Agent {
  id: string;               // permanent (ulid) — never changes
  projectId: string;
  teamId: string;
  name: string;
  role: string;
  model: string;
  effort: string | null;
  scopeGlobs: string[];
  instructions: string;
  workdir: string;
  status: AgentStatus;
  sessionId: string | null; // current Claude session
  generation: number;       // increments on each rotation
  queued: number;           // messages waiting for turn boundary
  contextTokens: number;    // latest context size
  contextWindow: number;
  sessionTokens: number;    // cumulative tokens this session
  compactions: number;
  lastError: string | null;
  createdAt: number;
  lastActiveAt: number;
}

// ── Feed (chat timeline) ────────────────────────────────────

interface FeedBase { id: string; ts: number }

export type FeedItem =
  | (FeedBase & { kind: 'user'; text: string; author: string })        // author: 'user' | agent name | 'watch' | 'axo'
  | (FeedBase & { kind: 'text'; text: string })                        // assistant prose
  | (FeedBase & {
      kind: 'tool';
      tool: string;
      summary: string;
      input: Record<string, unknown>;
      status: 'running' | 'ok' | 'error';
      result?: string;
      durationMs?: number;
    })
  | (FeedBase & { kind: 'system'; level: 'info' | 'warn' | 'error'; text: string })
  | (FeedBase & {
      kind: 'turn';
      isError: boolean;
      durationMs: number;
      costUsd: number;
      numTurns: number;
      interrupted?: boolean;
    });

export type FeedKind = FeedItem['kind'];

// ── Events (WS /ws, and GET /api/events?since=) ─────────────

export type NodeEvent =
  | { type: 'hello'; nodeId: string; version: string; seq: number; epoch: number }
  | { type: 'project:upsert'; project: Project }
  | { type: 'project:removed'; projectId: string }
  | { type: 'team:upsert'; team: Team }
  | { type: 'team:removed'; teamId: string }
  | { type: 'agent:upsert'; agent: Agent }
  | { type: 'agent:removed'; agentId: string }
  | { type: 'agent:feed'; agentId: string; item: FeedItem } // upsert by item.id
  | { type: 'agent:text-delta'; agentId: string; itemId: string; text: string }
  | { type: 'rate-limit'; info: Record<string, unknown> }
  | CoordinationEvent; // phase 2, defined below

export type EventEnvelope = NodeEvent & { seq: number; ts: number; nodeId: string };

// ── REST ────────────────────────────────────────────────────

export interface NodeState {
  nodeId: string;
  version: string;
  hostname: string;
  seq: number;
  epoch: number;
  projects: Project[];
  teams: Team[];
  agents: Agent[];
}

export interface CreateProjectReq { path: string; name?: string }
export interface CreateAgentReq {
  projectId: string;
  teamId?: string;
  name?: string;
  role?: string;
  model?: string;
  effort?: string;
  instructions?: string;
  task?: string;            // first message, sent immediately
}
export interface UpdateAgentReq { name?: string; model?: string; effort?: string | null; instructions?: string; scopeGlobs?: string[] }
export interface MessageReq { text: string; author?: string }
export interface FeedPage { items: FeedItem[]; hasMore: boolean }
export interface EventsPage { events: EventEnvelope[]; reset: boolean; seq: number; epoch: number }
export interface FsEntry { name: string; path: string; dir: boolean }

// ── Phase 2: teams, knock, InnerChat, watches, CLI (core2) ──
// Event types for this area are in `CoordinationEvent` (included in `NodeEvent`).

export interface CreateTeamReq {
  projectId: string;
  name: string;
  mode?: TeamMode;          // default: worktree for git projects, direct otherwise
  base?: string;            // worktree base ref; default project.baseBranch
}
export interface UpdateTeamReq { name?: string }
export interface ArchiveTeamReq { removeWorktree?: boolean }
export interface UpdateProjectReq { name?: string; baseBranch?: string | null; setupCmd?: string | null }

/** Body the knock hook forwards: Claude's PreToolUse payload, unchanged. */
export interface KnockReq { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string }
export interface KnockRes { allow: boolean; reason?: string; owner?: string; path?: string }

export type ChatTurnKind = 'ask' | 'tell' | 'answer';
export interface ChatTurn {
  id: string;
  threadId: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  kind: ChatTurnKind;
  text: string;
  ts: number;
}
export interface ChatThread {
  id: string;
  projectId: string;
  participants: { id: string; name: string }[];
  exchanges: number;        // ask + tell turns used (cap: maxExchanges)
  maxExchanges: number;
  status: 'open' | 'awaiting' | 'closed';
  createdAt: number;
  updatedAt: number;
}
export interface AskReq { to: string; message: string; timeoutMs?: number }
export interface AskRes {
  reply: string | null;     // null when timedOut
  timedOut: boolean;
  note?: string;
  threadId: string;
  exchangesRemaining: number;
}
export interface TellReq { to: string; message: string }
export interface TellRes { delivered: true; threadId: string; exchangesRemaining: number }
export interface WhoEntry { id: string; name: string; role: string; team: string; status: AgentStatus; scope: string[]; you: boolean }
export interface WhoRes { you: string | null; agents: WhoEntry[] }

export type WatchMode = 'command' | 'until';
export type WatchStatus = 'active' | 'delivered' | 'undeliverable' | 'cancelled';
export interface WatchResult {
  outcome: 'success' | 'failure' | 'timeout' | 'error';
  exitCode: number | null;
  summary: string;
  output: string;           // last 4KB
}
export interface Watch {
  id: string;
  agentId: string | null;   // null for team-level watches (worktree setup)
  agentName: string | null;
  teamId: string | null;
  label: string;
  mode: WatchMode;
  command: string;
  until: string;
  cwd: string;
  timeoutMs: number;
  status: WatchStatus;
  createdAt: number;
  finishedAt: number | null;
  result: WatchResult | null;
}
export interface CreateWatchReq {
  agentId?: string;         // required with the node token; implied by an agent token
  command?: string;
  until?: string;
  label?: string;
  timeoutMs?: number;       // default 30m, max 24h
  intervalMs?: number;      // until-mode poll interval
}
export interface CreateWatchRes { watch: Watch; reattached: boolean }

export interface RotateReq { note?: string }

/** `GET /api/me` (agent token): what `axo status` prints. */
export interface MeRes { agent: Agent; team: Team; project: Project; watches: Watch[]; teammates: WhoEntry[] }

export type CoordinationEvent =
  | { type: 'knock:denied'; agentId: string; agentName: string; tool: string; path: string; owner: string | null; reason: string }
  | { type: 'innerchat:turn'; thread: ChatThread; turn: ChatTurn }
  | { type: 'watch:upsert'; watch: Watch }
  | { type: 'watch:removed'; watchId: string };
