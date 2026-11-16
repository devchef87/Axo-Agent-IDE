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
  | (FeedBase & { kind: 'rotation'; generation: number; reason: string; note: string | null }) // context refresh divider
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
  // ── journalist + rotation (Phase 3) ──
  | { type: 'journalist:updated'; projectId: string; agentId: string | null; doc: 'state' | 'map' | 'decisions' }
  | { type: 'rotation:started'; agentId: string; reason: string }
  | { type: 'rotation:completed'; agentId: string; generation: number }
  | { type: 'rotation:aborted'; agentId: string; reason: string }
  // ── files (Phase 4) ──
  | { type: 'files:changed'; projectId: string; root: string; paths: string[] };

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

// ── journalist + rotation (Phase 3) ─────────────────────────

/** POST /agents/:id/refresh — fresh context, same agent/identity/chat. */
export interface RefreshReq { note?: string; mode?: 'interview' | 'journalist' }
/** POST /agents/:id/fork — new agent in the same team, seeded with this agent's state. */
export interface ForkReq { name?: string; task?: string }
/** GET/POST /agents/:id/state */
export interface StateDoc { text: string; updatedAt: number }
/** GET /projects/:id/context */
export interface ProjectContext { map: string; decisions: string }

// ── files (Phase 4) ─────────────────────────────────────────
// All routes live under /projects/:id/files/*. Paths are relative to the file root
// and confined to it (no absolute paths, no `..`, symlinks may not escape).
// The root is the project folder, or a team's worktree with `?team=<teamId>`.
// Raw/media URLs authenticate with `?token=` because <img>/<video> cannot send headers.

export interface FileEntry {
  name: string;
  path: string;            // relative to the root, '/'-separated
  dir: boolean;
  size?: number;           // files only
  hasChildren?: boolean;   // dirs only
}
/** GET /projects/:id/files/tree?path= */
export interface FileTree { root: string; path: string; entries: FileEntry[] }
/** GET /projects/:id/files/read?path= — content is null for binary or oversized files. */
export interface FileContent { path: string; content: string | null; binary: boolean; size: number; mtime: number; language: string }
/** POST /projects/:id/files/write — 409 if `baseMtime` is given and the file changed since. */
export interface WriteFileReq { path: string; content: string; baseMtime?: number }
export interface WriteFileRes { path: string; size: number; mtime: number }
/** POST /projects/:id/files/create */
export interface CreateFileReq { path: string; dir?: boolean; content?: string }
/** POST /projects/:id/files/rename */
export interface RenameFileReq { from: string; to: string }
/** POST /projects/:id/files/upload — base64 contents, written into `dir`. */
export interface UploadReq { dir?: string; files: { name: string; content: string }[] }
export interface UploadRes { uploaded: { path: string; size: number }[] }
/** GET /projects/:id/files/search?q=&limit= — filename match. */
export interface FileSearchRes { files: { path: string; name: string }[] }
export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'U' | '?';
/** GET /projects/:id/files/git-status */
export interface GitStatusRes { isRepo: boolean; branch: string | null; entries: { path: string; status: GitFileStatus }[] }
export interface FileDiff { path: string; status: 'added' | 'modified' | 'deleted'; additions: number; deletions: number; patch: string }
/** GET /projects/:id/files/diff?path= (omit path for the whole working tree) */
export interface DiffRes { diffs: FileDiff[] }
/** GET /projects/:id/files/original?path= — the file at HEAD; null if untracked/new. */
export interface OriginalRes { path: string; content: string | null }

