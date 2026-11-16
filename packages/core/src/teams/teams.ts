import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { basename } from 'node:path';
import type { Agent, ArchiveTeamReq, BranchDiff, CreateAgentReq, CreateTeamReq, MergeRes, Project, Team, TeamMode, UpdateProjectReq } from '@axo/protocol';
import type { Store } from '../store/db.ts';
import type { EventBus } from '../events.ts';
import type { AgentRuntime } from '../runtime/agent-runtime.ts';
import { ulid } from '../util/ulid.ts';
import { ContextFiles, excludeFromGit } from '../journalist/files.ts';
import { HttpError } from '../util/http-error.ts';
import { branchDiff, currentBranch, mergeBranch } from './merge.ts';

const NAME_RE = /^[\w][\w .-]{0,39}$/;

/** Runs `git` and returns trimmed stdout; throws HttpError(409) with git's stderr on failure. */
function git(cwd: string, args: string[], timeout = 60_000): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim();
  } catch (e: any) {
    const msg = String(e.stderr || e.message || '').trim().split('\n').slice(-3).join('\n');
    throw new HttpError(409, `git ${args[0]} failed: ${msg}`);
  }
}
function gitOk(cwd: string, args: string[]): boolean {
  try { execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 10_000 }); return true; } catch { return false; }
}

function checkStrategy(s: unknown): 'merge' | 'squash' {
  if (s === 'merge' || s === 'squash') return s;
  throw new HttpError(400, `strategy must be 'merge' or 'squash'`);
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'team';
}

export interface TeamsDeps {
  store: Store;
  bus: EventBus;
  runtime: AgentRuntime;
  /** Start the project's setup command in a new worktree (wired to Watches by the node). */
  runSetup?: (team: Team, command: string) => void;
}

/** Teams: create (with an optional git worktree), rename, archive. Project settings live here too. */
export class Teams {
  private readonly d: TeamsDeps;
  constructor(deps: TeamsDeps) { this.d = deps; }

  create(req: CreateTeamReq): Team {
    const { store, bus } = this.d;
    const project = store.getProject(req.projectId);
    if (!project) throw new HttpError(404, 'project not found');
    const name = (req.name ?? '').trim();
    if (!NAME_RE.test(name)) throw new HttpError(400, 'team name: 1-40 letters, numbers, space . _ -');
    if (this.active(project.id).some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      throw new HttpError(409, `a team named ${name} already exists`);
    }
    const mode: TeamMode = req.mode ?? (project.isGit ? 'worktree' : 'direct');
    if (mode !== 'worktree' && mode !== 'shared' && mode !== 'direct') throw new HttpError(400, `invalid mode ${mode}`);
    if (mode !== 'direct' && !project.isGit) throw new HttpError(400, `${mode} mode needs a git project; use direct`);

    const team: Team = {
      id: ulid(), projectId: project.id, name, mode, branch: mode === 'direct' ? null : project.baseBranch,
      worktreePath: null, createdAt: Date.now(), archivedAt: null,
    };
    if (mode === 'worktree') {
      const base = req.base?.trim() || project.baseBranch || 'HEAD';
      const { branch, path } = this.addWorktree(project, slugify(name), base);
      team.branch = branch;
      team.worktreePath = path;
    }
    store.insertTeam(team);
    if (req.goal?.trim()) this.writeGoal(project, team, req.goal);
    bus.publish({ type: 'team:upsert', team });
    if (team.worktreePath && project.setupCmd?.trim()) this.d.runSetup?.(team, project.setupCmd.trim());
    return team;
  }

  rename(id: string, rawName: string): Team {
    const team = this.get(id);
    const name = rawName.trim();
    if (!NAME_RE.test(name)) throw new HttpError(400, 'team name: 1-40 letters, numbers, space . _ -');
    if (this.active(team.projectId).some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) {
      throw new HttpError(409, `a team named ${name} already exists`);
    }
    // Branch and worktree keep their original slug: renaming must not move anyone's workdir.
    // The team brief is keyed by name, so it follows the rename.
    const project = this.d.store.getProject(team.projectId)!;
    const files = new ContextFiles(project);
    const brief = files.read(files.teamBriefPath(team.name));
    if (brief && name !== team.name) {
      files.write(files.teamBriefPath(name), brief.replace(/^# Team .*$/m, `# Team ${name}`));
      rmSync(files.teamBriefPath(team.name), { force: true });
    }
    team.name = name;
    this.d.store.saveTeam(team);
    this.d.bus.publish({ type: 'team:upsert', team });
    return team;
  }

  /**
   * Archive: stop the team's agents and hide the team. The branch is always kept. The worktree is
   * removed only on request, and only if clean (no --force: uncommitted work is never discarded).
   */
  async archive(id: string, req: ArchiveTeamReq = {}): Promise<Team> {
    const { store, bus, runtime } = this.d;
    const team = this.get(id);
    if (team.archivedAt) return team;
    if (req.removeWorktree && team.worktreePath && existsSync(team.worktreePath)) {
      const project = store.getProject(team.projectId)!;
      const dirty = git(team.worktreePath, ['status', '--porcelain'], 15_000);
      if (dirty) throw new HttpError(409, `worktree has uncommitted changes; commit or discard them first:\n${dirty.split('\n').slice(0, 10).join('\n')}`);
      git(project.path, ['worktree', 'remove', team.worktreePath]);
    }
    for (const a of runtime.list().filter((x) => x.teamId === id)) {
      if (a.status !== 'stopped') await runtime.stop(a.id);
    }
    team.archivedAt = Date.now();
    store.saveTeam(team);
    bus.publish({ type: 'team:upsert', team });
    return team;
  }

  // ── team brief (goal) ────────────────────────────────────

  /** The team brief the journalist feeds every teammate's prompt (`.axo/context/teams/<name>.md`). */
  brief(teamId: string): string {
    const team = this.get(teamId);
    const files = new ContextFiles(this.d.store.getProject(team.projectId)!);
    return files.read(files.teamBriefPath(team.name));
  }

  /** Set the goal: replaces the brief's `## Goal` section, keeping anything else in it. */
  setGoal(teamId: string, goal: string): Team {
    const team = this.get(teamId);
    this.writeGoal(this.d.store.getProject(team.projectId)!, team, goal);
    this.d.bus.publish({ type: 'team:upsert', team });
    return team;
  }

  private writeGoal(project: Project, team: Team, goal: string): void {
    const text = goal.trim();
    if (text.length > 4000) throw new HttpError(413, 'goal too long (4k chars max); link to a spec file instead');
    const files = ContextFiles.ensure(project);
    const path = files.teamBriefPath(team.name);
    const current = files.read(path);
    const section = text ? `## Goal\n${text}\n` : '';
    let next: string;
    if (!current.trim()) {
      const where = team.branch ? `\n## Where\nBranch \`${team.branch}\`${team.worktreePath ? ` in \`${team.worktreePath}\`` : ''}.\n` : '';
      next = `# Team ${team.name}\n\n${section}${where}`;
    } else if (/^## Goal\s*$/m.test(current)) {
      next = current.replace(/^## Goal\s*\n[\s\S]*?(?=^## |(?![\s\S]))/m, section ? `${section}\n` : '');
    } else {
      next = current.replace(/^(# .*\n)/, `$1\n${section}`);
      if (next === current) next = `${section}\n${current}`;
    }
    files.write(path, next);
  }

  updateProject(id: string, req: UpdateProjectReq): Project {
    const p = this.d.store.getProject(id);
    if (!p) throw new HttpError(404, 'project not found');
    if (req.name !== undefined) {
      if (!req.name.trim()) throw new HttpError(400, 'name required');
      p.name = req.name.trim();
    }
    if (req.baseBranch !== undefined) {
      const b = req.baseBranch?.trim() || null;
      if (b && p.isGit && !gitOk(p.path, ['rev-parse', '--verify', '--quiet', `${b}^{commit}`])) {
        throw new HttpError(400, `no such branch or ref: ${b}`);
      }
      p.baseBranch = b;
    }
    if (req.setupCmd !== undefined) p.setupCmd = req.setupCmd?.trim() || null;
    this.d.store.saveProject(p);
    this.d.bus.publish({ type: 'project:upsert', project: p });
    return p;
  }

  // ── per-agent worktrees ──────────────────────────────────

  /**
   * Create an agent, optionally in its own worktree `.axo/worktrees/<team>--<agent>` on branch
   * `axo/<team>--<agent>` off the team branch (SPEC §6: a risky task in parallel). The task is
   * delivered only once the agent sits in its final workdir.
   */
  createAgent(req: CreateAgentReq): Agent {
    const { runtime, store } = this.d;
    if (req.teamId && store.getTeam(req.teamId)?.archivedAt) throw new HttpError(400, 'team is archived');
    if (!req.ownWorktree) return runtime.create(req);
    const project = store.getProject(req.projectId);
    if (!project) throw new HttpError(404, 'project not found');
    if (!project.isGit) throw new HttpError(400, 'a per-agent worktree needs a git project');
    const agent = runtime.create({ ...req, task: undefined });
    try {
      const team = this.get(agent.teamId);
      const base = team.mode === 'worktree' ? team.branch! : (project.baseBranch ?? 'HEAD');
      const teamSlug = team.worktreePath ? basename(team.worktreePath) : slugify(team.name);
      const { path } = this.addWorktree(project, `${teamSlug}--${slugify(agent.name)}`, base);
      const moved = runtime.setWorkdir(agent.id, path);
      if (req.task?.trim()) runtime.deliver(agent.id, req.task, 'user');
      return moved;
    } catch (e) {
      void runtime.remove(agent.id);
      throw e;
    }
  }

  // ── merge view ───────────────────────────────────────────

  /** Team branch vs the project's base branch. */
  diff(teamId: string): BranchDiff {
    const { project, team } = this.teamBranch(teamId);
    return branchDiff(project.path, project.baseBranch!, team.branch!, team.worktreePath);
  }

  /** Merge the team branch into the project's base branch. */
  merge(teamId: string, strategy: 'merge' | 'squash' = 'merge'): MergeRes {
    const { project, team } = this.teamBranch(teamId);
    const res = mergeBranch(project.path, project.baseBranch!, team.branch!, checkStrategy(strategy), team.worktreePath, `team ${team.name}`);
    this.d.bus.publish({ type: 'team:merged', teamId, agentId: null, base: res.base, branch: res.branch, commit: res.commit, strategy: res.strategy });
    return res;
  }

  /** A per-agent worktree branch vs its team branch. */
  agentDiff(agentId: string): BranchDiff {
    const { project, agent, base, branch } = this.agentBranch(agentId);
    return branchDiff(project.path, base, branch, agent.workdir);
  }

  /** Merge a per-agent worktree branch into its team branch. */
  mergeAgent(agentId: string, strategy: 'merge' | 'squash' = 'merge'): MergeRes {
    const { project, agent, base, branch } = this.agentBranch(agentId);
    const res = mergeBranch(project.path, base, branch, checkStrategy(strategy), agent.workdir, `${agent.name}'s work`);
    this.d.bus.publish({ type: 'team:merged', teamId: agent.teamId, agentId, base: res.base, branch: res.branch, commit: res.commit, strategy: res.strategy });
    return res;
  }

  private teamBranch(teamId: string): { project: Project; team: Team } {
    const team = this.get(teamId);
    const project = this.d.store.getProject(team.projectId)!;
    if (team.mode !== 'worktree' || !team.branch) throw new HttpError(400, `team ${team.name} works on the main checkout (${team.mode} mode); there is no team branch to merge`);
    if (!project.baseBranch) throw new HttpError(400, 'the project has no base branch set');
    return { project, team };
  }

  private agentBranch(agentId: string): { project: Project; agent: Agent; base: string; branch: string } {
    const agent = this.d.runtime.get(agentId);
    const team = this.get(agent.teamId);
    const project = this.d.store.getProject(agent.projectId)!;
    const teamDir = team.worktreePath ?? project.path;
    const branch = agent.workdir !== teamDir ? currentBranch(agent.workdir) : null;
    if (!branch?.startsWith('axo/')) throw new HttpError(400, `${agent.name} works in the team checkout, not its own worktree`);
    const base = team.mode === 'worktree' ? team.branch : currentBranch(project.path) ?? project.baseBranch;
    if (!base) throw new HttpError(400, 'cannot tell which branch to merge into');
    return { project, agent, base, branch };
  }

  get(id: string): Team {
    const t = this.d.store.getTeam(id);
    if (!t) throw new HttpError(404, 'team not found');
    return t;
  }

  private active(projectId: string): Team[] {
    return this.d.store.listTeams().filter((t) => t.projectId === projectId && !t.archivedAt);
  }

  /** `git worktree add <project>/.axo/worktrees/<slug> -b axo/<slug> <base>`, picking a free slug. */
  private addWorktree(project: Project, slug: string, base: string): { branch: string; path: string } {
    if (!gitOk(project.path, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])) {
      throw new HttpError(400, `base ref not found: ${base} (does the repo have a commit yet?)`);
    }
    const root = join(project.path, '.axo', 'worktrees');
    let s = slug;
    for (let n = 2; existsSync(join(root, s)) || gitOk(project.path, ['rev-parse', '--verify', '--quiet', `refs/heads/axo/${s}`]); n++) {
      s = `${slug}-${n}`;
    }
    excludeFromGit(project.path); // .axo/ (worktrees live there) stays out of git; .gitignore is never touched
    mkdirSync(root, { recursive: true });
    const path = join(root, s);
    const branch = `axo/${s}`;
    git(project.path, ['worktree', 'add', path, '-b', branch, base]);
    return { branch, path };
  }
}
