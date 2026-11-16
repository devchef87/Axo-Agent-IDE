import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type { BranchDiff, DiffFile, MergeRes } from '@axo/protocol';
import { HttpError } from '../util/http-error.ts';

const MAX_PATCH = 512 * 1024;
const MAX_COMMITS = 100;

interface GitResult { ok: boolean; out: string; err: string }

function run(cwd: string, args: string[], timeout = 60_000): GitResult {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, out, err: '' };
  } catch (e: any) {
    return { ok: false, out: String(e.stdout ?? ''), err: String(e.stderr || e.message || '') };
  }
}
function must(cwd: string, args: string[]): string {
  const r = run(cwd, args);
  if (!r.ok) throw new HttpError(409, `git ${args[0]} failed: ${r.err.trim().split('\n').slice(-3).join('\n')}`);
  return r.out.trim();
}

/** Current branch of a checkout, or null if detached/not a repo. */
export function currentBranch(cwd: string): string | null {
  const r = run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 10_000);
  const b = r.out.trim();
  return r.ok && b && b !== 'HEAD' ? b : null;
}

/** Uncommitted changes (porcelain lines). `untracked` false ignores untracked files. */
export function dirtyFiles(cwd: string, untracked = true): string[] {
  const args = ['status', '--porcelain', ...(untracked ? [] : ['--untracked-files=no'])];
  return must(cwd, args).split('\n').filter(Boolean);
}

/** Where each branch is checked out (`git worktree list --porcelain`), by branch name. */
function checkouts(repo: string): Map<string, string> {
  const out = new Map<string, string>();
  let path = '';
  for (const line of must(repo, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    else if (line.startsWith('branch refs/heads/')) out.set(line.slice(18), path);
  }
  return out;
}

/** `branch` compared with `base`: commits, numstat and unified diff from their merge-base. */
export function branchDiff(repo: string, base: string, branch: string, worktree: string | null): BranchDiff {
  const counts = must(repo, ['rev-list', '--left-right', '--count', `${base}...${branch}`]).split(/\s+/).map(Number);
  const commits = must(repo, ['log', `--max-count=${MAX_COMMITS}`, '--format=%h%x09%s', `${base}..${branch}`])
    .split('\n').filter(Boolean).map((l) => { const i = l.indexOf('\t'); return { sha: l.slice(0, i), subject: l.slice(i + 1) }; });
  const files: DiffFile[] = must(repo, ['diff', '--numstat', `${base}...${branch}`]).split('\n').filter(Boolean).map((l) => {
    const [a, d, ...p] = l.split('\t');
    const binary = a === '-' && d === '-';
    return { path: p.join('\t'), additions: binary ? 0 : Number(a), deletions: binary ? 0 : Number(d), binary };
  });
  let patch = must(repo, ['diff', `${base}...${branch}`]);
  const truncated = Buffer.byteLength(patch) > MAX_PATCH;
  if (truncated) patch = Buffer.from(patch).subarray(0, MAX_PATCH).toString('utf8');
  return {
    base, branch, behind: counts[0] ?? 0, ahead: counts[1] ?? 0, commits, files, patch, truncated,
    dirty: worktree ? dirtyFiles(worktree) : [],
  };
}

/**
 * Merge `branch` into `base`. Refuses (409, nothing changed) when: the branch's worktree has
 * uncommitted changes, there is nothing to merge, the checkout holding `base` has tracked changes,
 * or the merge conflicts. If `base` is checked out somewhere the merge runs there (so that
 * checkout stays in sync); otherwise it is done with plumbing (merge-tree + commit-tree).
 */
export function mergeBranch(repo: string, base: string, branch: string, strategy: 'merge' | 'squash', branchWorktree: string | null, title: string): MergeRes {
  if (branchWorktree) {
    const dirty = dirtyFiles(branchWorktree);
    if (dirty.length) {
      throw new HttpError(409, `${branch} has uncommitted changes in ${branchWorktree}; commit them first (they would not be merged):\n${dirty.slice(0, 15).join('\n')}`);
    }
  }
  const ahead = Number(must(repo, ['rev-list', '--count', `${base}..${branch}`]));
  if (!ahead) throw new HttpError(409, `nothing to merge: ${base} already contains everything on ${branch}`);
  const subjects = must(repo, ['log', '--reverse', '--max-count=50', '--format=- %s', `${base}..${branch}`]);
  const message = strategy === 'squash' ? `${title} (squash of ${branch})\n\n${subjects}` : `Merge ${branch}: ${title}`;

  const at = checkouts(repo).get(base);
  if (at) {
    if (branchWorktree && same(at, branchWorktree)) throw new HttpError(400, `${branch} and ${base} are the same checkout`);
    const dirty = dirtyFiles(at, false);
    if (dirty.length) {
      throw new HttpError(409, `${base} is checked out at ${at} with uncommitted changes; commit or stash them first:\n${dirty.slice(0, 15).join('\n')}`);
    }
    const attempt = strategy === 'squash'
      ? run(at, ['merge', '--squash', branch])
      : run(at, ['merge', '--no-ff', '--no-commit', branch]);
    if (!attempt.ok) {
      const conflicts = run(at, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
      // The checkout was clean before we started, so this only undoes our merge attempt.
      if (strategy === 'squash') run(at, ['reset', '--merge']); else run(at, ['merge', '--abort']);
      throw new HttpError(409, conflicts.length
        ? `merging ${branch} into ${base} conflicts in:\n${conflicts.join('\n')}\nResolve on ${branch} (e.g. merge ${base} into it), commit, and try again. Nothing was changed.`
        : `git merge failed: ${(attempt.err || attempt.out).trim().split('\n').slice(-4).join('\n')}\nNothing was changed.`);
    }
    must(at, ['commit', '-q', '-m', message]);
    return { merged: true, strategy, base, branch, commit: must(at, ['rev-parse', 'HEAD']) };
  }

  // base is not checked out anywhere: build the commit without touching any working tree.
  const tree = run(repo, ['merge-tree', '--write-tree', '--name-only', base, branch]);
  if (!tree.ok) {
    const lines = tree.out.trim().split('\n');
    if (lines.length > 1 && /^[0-9a-f]{40}/.test(lines[0])) {
      const rest = lines.slice(1);
      const end = rest.indexOf(''); // conflicted paths come first, then a blank line and messages
      const conflicts = end === -1 ? rest : rest.slice(0, end);
      throw new HttpError(409, `merging ${branch} into ${base} conflicts in:\n${conflicts.join('\n')}\nResolve on ${branch} (e.g. merge ${base} into it), commit, and try again. Nothing was changed.`);
    }
    throw new HttpError(409, `cannot merge into ${base} without a checkout (needs git ≥ 2.38): check out ${base} in the project and retry.\n${tree.err.trim()}`);
  }
  const treeSha = tree.out.trim().split('\n')[0];
  const oldBase = must(repo, ['rev-parse', base]);
  const parents = strategy === 'squash' ? ['-p', oldBase] : ['-p', oldBase, '-p', must(repo, ['rev-parse', branch])];
  const commit = must(repo, ['commit-tree', treeSha, ...parents, '-m', message]);
  must(repo, ['update-ref', `refs/heads/${base}`, commit, oldBase]);
  return { merged: true, strategy, base, branch, commit };
}

function same(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
}
