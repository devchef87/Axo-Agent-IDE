// On-disk context files inside each project: <project>/.axo/…
// Agents can read these by path, and they travel with the project.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Agent, Project } from '@axo/protocol';

const CURSOR_RE = /^<!-- axo:cursor=(\d+) -->\n?/;

export class ContextFiles {
  readonly root: string;
  constructor(project: Project) { this.root = join(project.path, '.axo'); }

  static ensure(project: Project): ContextFiles {
    const f = new ContextFiles(project);
    for (const d of ['context', 'state', 'handoffs']) mkdirSync(join(f.root, d), { recursive: true });
    if (project.isGit) excludeFromGit(project.path);
    return f;
  }

  statePath(agentName: string) { return join(this.root, 'state', `${safe(agentName)}.md`); }
  get mapPath() { return join(this.root, 'context', 'map.md'); }
  get decisionsPath() { return join(this.root, 'context', 'decisions.md'); }
  teamBriefPath(teamName: string) { return join(this.root, 'context', 'teams', `${safe(teamName)}.md`); }
  handoffDir(agentName: string) { return join(this.root, 'handoffs', safe(agentName)); }

  /** State doc body + the feed cursor it was built up to. */
  readState(agentName: string): { text: string; cursor: number; mtime: number } {
    const p = this.statePath(agentName);
    if (!existsSync(p)) return { text: '', cursor: 0, mtime: 0 };
    const raw = readFileSync(p, 'utf8');
    const m = CURSOR_RE.exec(raw);
    return { text: raw.replace(CURSOR_RE, ''), cursor: m ? Number(m[1]) : 0, mtime: statSync(p).mtimeMs };
  }
  writeState(agentName: string, text: string, cursor: number): void {
    atomicWrite(this.statePath(agentName), `<!-- axo:cursor=${cursor} -->\n${text.trim()}\n`);
  }
  renameState(from: string, to: string): void {
    const a = this.statePath(from);
    if (existsSync(a)) renameSync(a, this.statePath(to));
    const h = this.handoffDir(from);
    if (existsSync(h)) renameSync(h, this.handoffDir(to));
  }

  read(path: string): string { return existsSync(path) ? readFileSync(path, 'utf8') : ''; }
  write(path: string, text: string): void { atomicWrite(path, text.trim() + '\n'); }
  append(path: string, text: string): void {
    mkdirSync(join(path, '..'), { recursive: true });
    appendFileSync(path, text);
  }

  writeHandoff(agentName: string, generation: number, text: string, keep = 10): string {
    const dir = this.handoffDir(agentName);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${String(generation).padStart(4, '0')}.md`);
    writeFileSync(p, text.trim() + '\n');
    const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f), { force: true });
    return p;
  }
}

function safe(name: string): string { return name.replace(/[^\w.-]/g, '_'); }

function atomicWrite(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Add `.axo/` to .git/info/exclude (never touches the user's .gitignore). */
export function excludeFromGit(projectPath: string): void {
  try {
    let gitDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: projectPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!isAbsolute(gitDir)) gitDir = join(projectPath, gitDir);
    const ex = join(gitDir, 'info', 'exclude');
    const cur = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
    if (!cur.split('\n').some((l) => l.trim() === '.axo/' || l.trim() === '.axo')) {
      mkdirSync(join(gitDir, 'info'), { recursive: true });
      appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}# Axo agent context\n.axo/\n`);
    }
  } catch { /* not a git repo */ }
}

export function gitSummary(cwd: string): string {
  const run = (args: string[]) => {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { return ''; }
  };
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch) return '';
  const status = run(['status', '--short']).split('\n').filter(Boolean);
  const log = run(['log', '--oneline', '-5']);
  return [
    `branch: ${branch}`,
    status.length ? `uncommitted changes (${status.length}):\n${status.slice(0, 40).join('\n')}${status.length > 40 ? '\n…' : ''}` : 'working tree clean',
    log ? `recent commits:\n${log}` : '',
  ].filter(Boolean).join('\n');
}

export function agentLabel(a: Agent): string { return `${a.name} (${a.role})`; }
