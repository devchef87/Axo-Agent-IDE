import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Agent } from '@axo/protocol';

// ── globs ───────────────────────────────────────────────────
// Small glob → RegExp (no dependency): `**`, `*`, `?`, `{a,b}`. A pattern with no wildcard, or
// ending in `/`, also matches everything below it (`src/api` ≡ `src/api/**`).

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (g.endsWith('/')) g += '**';
  else if (!/[*?{]/.test(g)) g += '{,/**}';
  let re = '';
  let depth = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { depth++; re += '(?:'; }
    else if (c === '}' && depth) { depth--; re += ')'; }
    else if (c === ',' && depth) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

export function matchGlobs(rel: string, globs: string[]): string | null {
  for (const g of globs) if (globToRegExp(g).test(rel)) return g;
  return null;
}

// ── paths ───────────────────────────────────────────────────

/** realpath of the nearest existing ancestor + the rest (the file being written may not exist yet). */
export function realish(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** `abs` relative to `root` with forward slashes, or null if it is outside `root`. Handles /var → /private/var. */
export function relativeInside(root: string, abs: string): string | null {
  const r = relative(realish(root), realish(abs));
  if (r === '') return '';
  if (r.startsWith('..') || isAbsolute(r)) return null;
  return r.split(sep).join('/');
}

/** File paths a write tool targets, from Claude's PreToolUse `tool_input`. */
export function toolPaths(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const out: string[] = [];
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof input[k] === 'string') out.push(input[k] as string);
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) if (e && typeof e.file_path === 'string') out.push(e.file_path);
  }
  return [...new Set(out)];
}

// ── the knock decision ──────────────────────────────────────

export interface KnockDecision { allow: boolean; reason?: string; owner?: string; path?: string }

/**
 * May `agent` write `paths`? Paths may be absolute or relative to `cwd`. Each is checked against
 * (1) the agent's own scope, relative to its workdir, and (2) the scope of every other agent,
 * relative to *that* agent's workdir, so teams sharing a checkout protect each other too.
 * Paths outside the agent's workdir pass check (1): scopes only describe the workdir.
 */
export function decide(agent: Agent, others: Agent[], paths: string[], cwd?: string): KnockDecision {
  for (const raw of paths) {
    const abs = isAbsolute(raw) ? raw : resolve(cwd || agent.workdir, raw);
    const mine = relativeInside(agent.workdir, abs);
    const ownMatch = mine !== null && agent.scopeGlobs.length ? matchGlobs(mine, agent.scopeGlobs) : null;

    let owner: { agent: Agent; glob: string; rel: string } | null = null;
    for (const o of others) {
      if (o.id === agent.id || !o.scopeGlobs.length) continue;
      const rel = relativeInside(o.workdir, abs);
      // Team worktrees live under <project>/.axo/; a shared-checkout scope doesn't reach into them.
      if (rel === null || rel === '.axo' || rel.startsWith('.axo/')) continue;
      const g = matchGlobs(rel, o.scopeGlobs);
      if (g) { owner = { agent: o, glob: g, rel }; break; }
    }

    const shown = mine ?? abs;
    if (mine !== null && agent.scopeGlobs.length && !ownMatch) {
      const yours = agent.scopeGlobs.join(', ');
      return {
        allow: false, path: shown, owner: owner?.agent.name,
        reason: owner
          ? `Axo: ${shown} is outside your scope (${yours}); it belongs to ${owner.agent.name} (${owner.glob}). `
            + `Ask them to make the change: axo ask ${owner.agent.name} "<what you need>" (or axo tell for a non-blocking handoff).`
          : `Axo: ${shown} is outside your scope (${yours}). If it really needs changing, say so in your reply `
            + 'to the user, or find the owner with `axo who`.',
      };
    }
    if (owner && !ownMatch) {
      return {
        allow: false, path: shown, owner: owner.agent.name,
        reason: `Axo: ${owner.rel} is owned by ${owner.agent.name} (scope ${owner.glob}). `
          + `Ask them to make the change: axo ask ${owner.agent.name} "<what you need>" (or axo tell for a non-blocking handoff).`,
      };
    }
  }
  return { allow: true };
}
