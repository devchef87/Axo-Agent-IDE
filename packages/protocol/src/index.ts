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
  | { type: 'rate-limit'; info: Record<string, unknown> };

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
