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
  | { type: 'rotation:aborted'; agentId: string; reason: string };

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
