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
  | { type: 'files:changed'; projectId: string; root: string; paths: string[] } // files (Phase 4)
  | CoordinationEvent; // phase 2, defined below

export type EventEnvelope = NodeEvent & { seq: number; ts: number; nodeId: string };

// ── REST ────────────────────────────────────────────────────

export interface NodeState {
  nodeId: string;
  version: string;
  build: string;           // bundle content hash ('dev' from source); see VersionInfo
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
  ownWorktree?: boolean;    // [core2] own worktree + branch off the team branch (SPEC §6 per-agent worktree)
}
export interface UpdateAgentReq { name?: string; model?: string; effort?: string | null; instructions?: string; scopeGlobs?: string[] }
export interface MessageReq { text: string; author?: string }
export interface FeedPage { items: FeedItem[]; hasMore: boolean }
export interface EventsPage { events: EventEnvelope[]; reset: boolean; seq: number; epoch: number }
export interface FsEntry { name: string; path: string; dir: boolean }

// ── journalist + rotation (Phase 3) ─────────────────────────

/** POST /agents/:id/refresh — fresh context, same agent/identity/chat. */
export interface RefreshReq { note?: string; mode?: 'interview' | 'journalist'; reason?: 'requested' } // reason: set when an agent asks via `axo rotate`
/** POST /agents/:id/fork — new agent in the same team, seeded with this agent's state. */
export interface ForkReq { name?: string; task?: string }
/** GET/POST /agents/:id/state */
export interface StateDoc { text: string; updatedAt: number }
/** GET /projects/:id/context */
export interface ProjectContext { map: string; decisions: string }

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

/** `GET /api/me` (agent token): what `axo status` prints. */
export interface MeRes { agent: Agent; team: Team; project: Project; watches: Watch[]; teammates: WhoEntry[] }

// Merge view: a branch compared with the branch it merges into.
export interface DiffFile { path: string; additions: number; deletions: number; binary: boolean }
export interface BranchDiff {
  base: string;             // merges into this branch
  branch: string;           // the team (or per-agent) branch
  ahead: number;            // commits on branch not on base
  behind: number;           // commits on base not on branch
  commits: { sha: string; subject: string }[];   // newest first, max 100
  files: DiffFile[];
  patch: string;            // unified diff base...branch (merge-base to branch tip)
  truncated: boolean;       // patch was cut at 512KB
  dirty: string[];          // uncommitted changes in the branch's worktree (`git status --porcelain`): not part of the diff
}
export interface MergeReq { strategy?: 'merge' | 'squash' }  // default 'merge'
export interface MergeRes { merged: true; strategy: 'merge' | 'squash'; base: string; branch: string; commit: string }

export type CoordinationEvent =
  | { type: 'knock:denied'; agentId: string; agentName: string; tool: string; path: string; owner: string | null; reason: string }
  | { type: 'innerchat:turn'; thread: ChatThread; turn: ChatTurn }
  | { type: 'watch:upsert'; watch: Watch }
  | { type: 'watch:removed'; watchId: string }
  | { type: 'team:merged'; teamId: string; agentId: string | null; base: string; branch: string; commit: string; strategy: 'merge' | 'squash' };

// ── Remote nodes / servers (Axo-Remote) ─────────────────────
// Served by every node at GET /api/version. `build` is a content hash of the
// bundle ('dev' from source) — it, not `version`, decides whether a node is stale.

export interface VersionInfo { version: string; build: string; nodeId: string; hostname: string }

/** A server the app manages over SSH. Persisted by the app (servers.json). No secrets:
 *  keys and passphrases stay with ssh-agent / Keychain / ~/.ssh/config. */
export interface ServerConfig {
  id: string;              // also the renderer's nodeKey
  name: string;
  host: string;            // hostname or ~/.ssh/config alias
  user?: string;
  port?: number;
  identityFile?: string;
  remotePort: number;      // node port on the server (default 31500, bound to 127.0.0.1)
  autoConnect: boolean;    // connect on app start
}
export type ServerInput = Omit<ServerConfig, 'id' | 'remotePort' | 'autoConnect'> & Partial<Pick<ServerConfig, 'remotePort' | 'autoConnect'>>;

/** Host block from ~/.ssh/config (wildcard patterns skipped). */
export interface SshHostEntry { alias: string; hostName?: string; user?: string; port?: number; identityFile?: string }

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface PreflightCheck { id: string; label: string; status: CheckStatus; detail: string }
export interface PreflightResult {
  ok: boolean;             // no 'fail' checks
  ts: number;
  checks: PreflightCheck[];
  nodePath?: string;       // absolute path of node on the server
  nodeFlags: string[];     // e.g. ['--experimental-sqlite'] on node 22.5–22.12
  pathEnv?: string;        // login-shell PATH on the server (given to the node)
  systemd: boolean;        // `systemctl --user` usable
  linger: boolean;
  deployedBuild?: string;
}

export type ServerPhase = 'idle' | 'preflight' | 'deploying' | 'connecting' | 'connected' | 'reconnecting' | 'updating' | 'error';
export interface ServerStatus {
  phase: ServerPhase;
  message?: string;        // progress or last error
  localPort?: number;      // tunnel endpoint on this Mac
  node?: VersionInfo;      // the running node, once reachable
  deployMode?: 'systemd' | 'nohup';
  updateAvailable: boolean;  // node.build !== bundled build
  updateWaiting: boolean;    // update requested, waiting for agents to finish their turns
  preflight?: PreflightResult;
}
export interface ServerView { config: ServerConfig; status: ServerStatus }

export interface LocalNodeStatus { node?: VersionInfo; updateAvailable: boolean; updateWaiting: boolean; message?: string }
export interface ServersSnapshot {
  bundled: { version: string; build: string };
  local: LocalNodeStatus;
  servers: ServerView[];
}

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

