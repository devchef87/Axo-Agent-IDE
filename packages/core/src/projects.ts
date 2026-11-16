import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Project, Team } from '@axo/protocol';
import type { Store } from './store/db.ts';
import type { EventBus } from './events.ts';
import { ulid } from './util/ulid.ts';
import { HttpError } from './util/http-error.ts';

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

export class Projects {
  private readonly store: Store;
  private readonly bus: EventBus;
  constructor(store: Store, bus: EventBus) {
    this.store = store;
    this.bus = bus;
  }

  create(rawPath: string, name?: string): Project {
    const path = resolve(expandHome(rawPath.trim()));
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(400, `Not a directory: ${path}`);
    const existing = this.store.listProjects().find((p) => p.path === path);
    if (existing) return existing;

    const isGit = git(path, ['rev-parse', '--is-inside-work-tree']) === 'true';
    const baseBranch = isGit ? git(path, ['rev-parse', '--abbrev-ref', 'HEAD']) : null;
    const project: Project = {
      id: ulid(), name: name?.trim() || basename(path), path, isGit,
      baseBranch: baseBranch && baseBranch !== 'HEAD' ? baseBranch : null, setupCmd: null, createdAt: Date.now(),
    };
    this.store.insertProject(project);
    this.bus.publish({ type: 'project:upsert', project });
    this.defaultTeam(project);
    return project;
  }

  /** Phase 1: every project has a shared/direct "main" team. Worktree teams arrive in phase 2. */
  defaultTeam(project: Project): Team {
    const found = this.store.listTeams().find((t) => t.projectId === project.id && !t.archivedAt);
    if (found) return found;
    const team: Team = {
      id: ulid(), projectId: project.id, name: 'main', mode: project.isGit ? 'shared' : 'direct',
      branch: project.baseBranch, worktreePath: null, createdAt: Date.now(), archivedAt: null,
    };
    this.store.insertTeam(team);
    this.bus.publish({ type: 'team:upsert', team });
    return team;
  }

  remove(id: string): void {
    if (!this.store.getProject(id)) throw new HttpError(404, 'project not found');
    this.store.deleteProject(id);
    this.bus.publish({ type: 'project:removed', projectId: id });
  }
}
