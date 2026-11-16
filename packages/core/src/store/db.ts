import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { Agent, AgentStatus, FeedItem, Project, Team, TeamMode } from '@axo/protocol';

const SCHEMA_VERSION = 1;

const MIGRATIONS: string[] = [
  /* v1 */ `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    is_git INTEGER NOT NULL DEFAULT 0, base_branch TEXT, setup_cmd TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE teams (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, mode TEXT NOT NULL, branch TEXT, worktree_path TEXT,
    created_at INTEGER NOT NULL, archived_at INTEGER
  );
  CREATE TABLE agents (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, effort TEXT,
    scope_globs TEXT NOT NULL DEFAULT '[]', instructions TEXT NOT NULL DEFAULT '',
    workdir TEXT NOT NULL, status TEXT NOT NULL, session_id TEXT, generation INTEGER NOT NULL DEFAULT 0,
    context_tokens INTEGER NOT NULL DEFAULT 0, context_window INTEGER NOT NULL DEFAULT 200000,
    session_tokens INTEGER NOT NULL DEFAULT 0, compactions INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, live_pid INTEGER, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
    UNIQUE (project_id, name)
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL, started_at INTEGER NOT NULL, initialized INTEGER NOT NULL DEFAULT 0,
    ended_at INTEGER, end_reason TEXT,
    turns INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0, cache_creation INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0, peak_context INTEGER NOT NULL DEFAULT 0, compactions INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sessions_agent ON sessions(agent_id, generation);
  CREATE TABLE feed (
    id TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    session_id TEXT, ts INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (agent_id, id)
  );
  CREATE INDEX feed_agent_ts ON feed(agent_id, ts);
  CREATE TABLE usage (
    agent_id TEXT NOT NULL, session_id TEXT NOT NULL, ts INTEGER NOT NULL,
    input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL,
    cache_creation INTEGER NOT NULL, cost_usd REAL NOT NULL
  );
  CREATE INDEX usage_agent_ts ON usage(agent_id, ts);
  CREATE INDEX usage_ts ON usage(ts);
  `,
];

const FEED_KEEP_PER_AGENT = 5000;

type Row = Record<string, any>;

export class Store {
  readonly db: DatabaseSync;

  constructor(home: string, file = 'axo.db') {
    this.db = new DatabaseSync(file === ':memory:' ? ':memory:' : join(home, file));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.migrate();
  }

  private migrate(): void {
    const current = (this.db.prepare('PRAGMA user_version').get() as Row).user_version as number;
    for (let v = current; v < SCHEMA_VERSION; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  close(): void { this.db.close(); }

  // ── projects ──────────────────────────────────────────────

  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as Row[]).map(toProject);
  }
  getProject(id: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? toProject(r) : null;
  }
  insertProject(p: Project): void {
    this.db.prepare(`INSERT INTO projects (id,name,path,is_git,base_branch,setup_cmd,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(p.id, p.name, p.path, p.isGit ? 1 : 0, p.baseBranch, p.setupCmd, p.createdAt);
  }
  deleteProject(id: string): void { this.db.prepare('DELETE FROM projects WHERE id = ?').run(id); }

  // ── teams ─────────────────────────────────────────────────

  listTeams(): Team[] {
    return (this.db.prepare('SELECT * FROM teams ORDER BY created_at').all() as Row[]).map(toTeam);
  }
  getTeam(id: string): Team | null {
    const r = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as Row | undefined;
    return r ? toTeam(r) : null;
  }
  insertTeam(t: Team): void {
    this.db.prepare(`INSERT INTO teams (id,project_id,name,mode,branch,worktree_path,created_at,archived_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(t.id, t.projectId, t.name, t.mode, t.branch, t.worktreePath, t.createdAt, t.archivedAt);
  }

  // ── agents ────────────────────────────────────────────────

  listAgents(): Agent[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY created_at').all() as Row[]).map(toAgent);
  }
  getAgent(id: string): Agent | null {
    const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    return r ? toAgent(r) : null;
  }
  agentNameTaken(projectId: string, name: string, exceptId?: string): boolean {
    const r = this.db.prepare('SELECT id FROM agents WHERE project_id = ? AND name = ?').get(projectId, name) as Row | undefined;
    return !!r && r.id !== exceptId;
  }
  insertAgent(a: Agent): void {
    this.db.prepare(`INSERT INTO agents (id,project_id,team_id,name,role,model,effort,scope_globs,instructions,workdir,status,
      session_id,generation,context_tokens,context_window,session_tokens,compactions,last_error,created_at,last_active_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(a.id, a.projectId, a.teamId, a.name, a.role, a.model, a.effort, JSON.stringify(a.scopeGlobs), a.instructions,
        a.workdir, a.status, a.sessionId, a.generation, a.contextTokens, a.contextWindow, a.sessionTokens, a.compactions,
        a.lastError, a.createdAt, a.lastActiveAt);
  }
  /** Persist the mutable fields of an agent. `queued` is runtime-only. */
  saveAgent(a: Agent): void {
    this.db.prepare(`UPDATE agents SET team_id=?, name=?, role=?, model=?, effort=?, scope_globs=?, instructions=?, workdir=?,
      status=?, session_id=?, generation=?, context_tokens=?, context_window=?, session_tokens=?, compactions=?, last_error=?,
      last_active_at=? WHERE id=?`)
      .run(a.teamId, a.name, a.role, a.model, a.effort, JSON.stringify(a.scopeGlobs), a.instructions, a.workdir, a.status,
        a.sessionId, a.generation, a.contextTokens, a.contextWindow, a.sessionTokens, a.compactions, a.lastError,
        a.lastActiveAt, a.id);
  }
  deleteAgent(id: string): void { this.db.prepare('DELETE FROM agents WHERE id = ?').run(id); }

  setLivePid(agentId: string, pid: number | null): void {
    this.db.prepare('UPDATE agents SET live_pid = ? WHERE id = ?').run(pid, agentId);
  }
  livePids(): { agentId: string; pid: number }[] {
    return (this.db.prepare('SELECT id, live_pid FROM agents WHERE live_pid IS NOT NULL').all() as Row[])
      .map((r) => ({ agentId: r.id, pid: r.live_pid }));
  }

  // ── sessions ──────────────────────────────────────────────

  insertSession(id: string, agentId: string, generation: number): void {
    this.db.prepare('INSERT OR IGNORE INTO sessions (id, agent_id, generation, started_at) VALUES (?,?,?,?)')
      .run(id, agentId, generation, Date.now());
  }
  /** True once Claude has emitted `init` for this session, i.e. a transcript exists and --resume is valid. */
  sessionInitialized(id: string): boolean {
    const r = this.db.prepare('SELECT initialized FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return !!r?.initialized;
  }
  markSessionInitialized(id: string): void {
    this.db.prepare('UPDATE sessions SET initialized = 1 WHERE id = ? AND initialized = 0').run(id);
  }
  recordTurn(sessionId: string, u: { input: number; output: number; cacheRead: number; cacheCreation: number; costUsd: number; context: number }): void {
    this.db.prepare(`UPDATE sessions SET turns = turns + 1, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
      cache_read = cache_read + ?, cache_creation = cache_creation + ?, cost_usd = cost_usd + ?,
      peak_context = MAX(peak_context, ?) WHERE id = ?`)
      .run(u.input, u.output, u.cacheRead, u.cacheCreation, u.costUsd, u.context, sessionId);
  }
  endSession(id: string, reason: string): void {
    this.db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(Date.now(), reason, id);
  }

  // ── feed ──────────────────────────────────────────────────

  upsertFeed(agentId: string, sessionId: string | null, item: FeedItem): void {
    this.db.prepare(`INSERT INTO feed (id, agent_id, session_id, ts, kind, data) VALUES (?,?,?,?,?,?)
      ON CONFLICT(agent_id, id) DO UPDATE SET data = excluded.data, kind = excluded.kind`)
      .run(item.id, agentId, sessionId, item.ts, item.kind, JSON.stringify(item));
  }
  getFeedItem(agentId: string, id: string): FeedItem | null {
    const r = this.db.prepare('SELECT data FROM feed WHERE agent_id = ? AND id = ?').get(agentId, id) as Row | undefined;
    return r ? JSON.parse(r.data) : null;
  }
  /** Newest-last page of feed items older than `before` (ts). */
  feedPage(agentId: string, before: number | null, limit: number): { items: FeedItem[]; hasMore: boolean } {
    const rows = (before
      ? this.db.prepare('SELECT data FROM feed WHERE agent_id = ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?').all(agentId, before, limit + 1)
      : this.db.prepare('SELECT data FROM feed WHERE agent_id = ? ORDER BY ts DESC, id DESC LIMIT ?').all(agentId, limit + 1)) as Row[];
    const hasMore = rows.length > limit;
    return { items: rows.slice(0, limit).reverse().map((r) => JSON.parse(r.data)), hasMore };
  }
  pruneFeed(agentId: string): void {
    this.db.prepare(`DELETE FROM feed WHERE agent_id = ? AND ts < (
      SELECT ts FROM feed WHERE agent_id = ? ORDER BY ts DESC LIMIT 1 OFFSET ?)`).run(agentId, agentId, FEED_KEEP_PER_AGENT);
  }

  // ── usage ─────────────────────────────────────────────────

  insertUsage(agentId: string, sessionId: string, u: { input: number; output: number; cacheRead: number; cacheCreation: number; costUsd: number }): void {
    this.db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?)')
      .run(agentId, sessionId, Date.now(), u.input, u.output, u.cacheRead, u.cacheCreation, u.costUsd);
  }
}

// ── row mappers ─────────────────────────────────────────────

function toProject(r: Row): Project {
  return { id: r.id, name: r.name, path: r.path, isGit: !!r.is_git, baseBranch: r.base_branch, setupCmd: r.setup_cmd, createdAt: r.created_at };
}
function toTeam(r: Row): Team {
  return { id: r.id, projectId: r.project_id, name: r.name, mode: r.mode as TeamMode, branch: r.branch,
    worktreePath: r.worktree_path, createdAt: r.created_at, archivedAt: r.archived_at };
}
function toAgent(r: Row): Agent {
  return {
    id: r.id, projectId: r.project_id, teamId: r.team_id, name: r.name, role: r.role, model: r.model, effort: r.effort,
    scopeGlobs: JSON.parse(r.scope_globs), instructions: r.instructions, workdir: r.workdir, status: r.status as AgentStatus,
    sessionId: r.session_id, generation: r.generation, queued: 0, contextTokens: r.context_tokens,
    contextWindow: r.context_window, sessionTokens: r.session_tokens, compactions: r.compactions, lastError: r.last_error,
    createdAt: r.created_at, lastActiveAt: r.last_active_at,
  };
}
