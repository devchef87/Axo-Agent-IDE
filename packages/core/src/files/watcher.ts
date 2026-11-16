// Live file changes for the editor. Agents edit files directly (not through the file API),
// so the node watches roots that someone is viewing and publishes files:changed.
//
// Watches are leased: the UI renews every minute while the editor shows a root; a root with
// no lease for LEASE_MS stops being watched. On macOS a single recursive fs.watch (FSEvents)
// is cheap. On Linux, recursive fs.watch would add an inotify watch for every directory
// including node_modules, so we watch directories one by one and skip ignored ones.
import { watch, type FSWatcher } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export const IGNORED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', '.next', '.nuxt', '.cache', '.turbo', 'dist', 'build', 'coverage', 'target', '.axo']);
const LEASE_MS = 5 * 60_000;
const DEBOUNCE_MS = 150;
const MAX_DIRS = 4000; // per root on Linux; beyond this we stop adding directory watches

export type ChangeHandler = (root: string, projectId: string, paths: string[]) => void;

export function isIgnored(rel: string): boolean {
  return rel.split('/').some((seg) => IGNORED_DIRS.has(seg) || seg === '.DS_Store');
}

class RootWatch {
  private readonly root: string;
  readonly projectId: string;
  private readonly onChange: ChangeHandler;
  private readonly recursive: boolean;
  private watchers = new Map<string, FSWatcher>(); // dir (abs) → watcher
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  expires = 0;
  truncated = false;
  failed = false;

  constructor(root: string, projectId: string, onChange: ChangeHandler, recursive: boolean) {
    this.root = root;
    this.projectId = projectId;
    this.onChange = onChange;
    this.recursive = recursive;
  }

  async start(): Promise<void> {
    if (this.recursive) {
      try {
        const w = watch(this.root, { recursive: true }, (_ev, name) => { if (name) this.queue(String(name).split(sep).join('/')); });
        w.on('error', () => { this.failed = true; this.stop(); });
        this.watchers.set(this.root, w);
      } catch {
        this.failed = true;
      }
      return;
    }
    await this.addDir(this.root);
  }

  private async addDir(dir: string): Promise<void> {
    if (this.watchers.has(dir)) return;
    if (this.watchers.size >= MAX_DIRS) { this.truncated = true; return; }
    try {
      const w = watch(dir, (_ev, name) => {
        if (!name) return;
        const rel = relative(this.root, join(dir, String(name))).split(sep).join('/');
        this.queue(rel);
        // A new directory needs its own watch (non-recursive mode).
        if (!isIgnored(rel)) void this.addDir(join(dir, String(name))).catch(() => {});
      });
      w.on('error', () => { w.close(); this.watchers.delete(dir); });
      this.watchers.set(dir, w);
    } catch (e: any) {
      if (e?.code === 'ENOSPC' || e?.code === 'EMFILE') this.truncated = true;
      return; // not a directory, or vanished
    }
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && !IGNORED_DIRS.has(e.name)) await this.addDir(join(dir, e.name));
    }
  }

  private queue(rel: string): void {
    if (!rel || isIgnored(rel)) return;
    this.pending.add(rel);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const paths = [...this.pending];
      this.pending.clear();
      // Drop watches for directories that disappeared.
      if (!this.recursive) {
        for (const p of paths) {
          const abs = join(this.root, p);
          const w = this.watchers.get(abs);
          if (w && abs !== this.root) void readdir(abs).catch(() => { w.close(); this.watchers.delete(abs); });
        }
      }
      if (paths.length) this.onChange(this.root, this.projectId, paths);
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }

  get size(): number { return this.watchers.size; }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}

import type { FileWatchRes as LeaseInfo } from '@axo/protocol';
export type { LeaseInfo };

export class FileWatcher {
  private roots = new Map<string, RootWatch>();
  private sweep: ReturnType<typeof setInterval>;
  private readonly onChange: ChangeHandler;
  private readonly recursive: boolean;

  constructor(onChange: ChangeHandler, opts: { recursive?: boolean } = {}) {
    this.onChange = onChange;
    // Native recursive watching is cheap on macOS/Windows; on Linux we walk directories ourselves.
    this.recursive = opts.recursive ?? process.platform !== 'linux';
    this.sweep = setInterval(() => this.expire(), 30_000);
    this.sweep.unref();
  }

  /** Start (or renew) watching `root` for LEASE_MS. */
  async lease(root: string, projectId: string, now = Date.now()): Promise<LeaseInfo> {
    let rw = this.roots.get(root);
    if (!rw) {
      rw = new RootWatch(root, projectId, this.onChange, this.recursive);
      this.roots.set(root, rw);
      await rw.start();
    }
    rw.expires = now + LEASE_MS;
    if (rw.failed) {
      rw.stop();
      this.roots.delete(root);
      return { watching: false, expiresAt: 0, truncated: false };
    }
    return { watching: true, expiresAt: rw.expires, truncated: rw.truncated };
  }

  /** Stop watching roots whose lease ran out. */
  expire(now = Date.now()): void {
    for (const [root, rw] of this.roots) {
      if (rw.expires <= now) { rw.stop(); this.roots.delete(root); }
    }
  }

  /** Stop watching every root of a removed project. */
  dropProject(projectId: string): void {
    for (const [root, rw] of this.roots) if (rw.projectId === projectId) { rw.stop(); this.roots.delete(root); }
  }

  watched(): string[] { return [...this.roots.keys()]; }
  dirCount(root: string): number { return this.roots.get(root)?.size ?? 0; }

  close(): void {
    clearInterval(this.sweep);
    for (const rw of this.roots.values()) rw.stop();
    this.roots.clear();
  }
}
