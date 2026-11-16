import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { HttpError } from '../util/http-error.ts';

/** Is `child` the same as, or inside, `parent`? Both must be absolute and normalised. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Resolve the nearest existing ancestor through symlinks (the target itself may not exist yet). */
function realOfExisting(p: string): string {
  let cur = p;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return cur === p ? real : resolve(real, relative(cur, p));
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      cur = up;
    }
  }
}

/**
 * Map a client-supplied relative path onto `root`, refusing anything that escapes it:
 * absolute paths, `..` segments, NUL bytes, and symlinks pointing outside.
 * '' (or '.') means the root itself.
 */
export function confine(root: string, rel: string | null | undefined): string {
  const norm = (rel ?? '').replace(/\\/g, '/');
  const p = norm === '.' ? '' : norm.replace(/^(\.\/)+/, '');
  if (p.includes('\0')) throw new HttpError(400, 'invalid path');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) throw new HttpError(400, 'path must be relative to the project');
  if (p.split('/').includes('..')) throw new HttpError(400, 'invalid path');
  const full = resolve(root, p);
  if (!isInside(root, full)) throw new HttpError(400, 'path outside project');
  const realRoot = realOfExisting(root);
  if (!isInside(realRoot, realOfExisting(full))) throw new HttpError(400, 'path outside project (symlink)');
  return full;
}

/** Root-relative, '/'-separated path for the wire. */
export function toRel(root: string, full: string): string {
  return relative(root, full).split(sep).join('/');
}
