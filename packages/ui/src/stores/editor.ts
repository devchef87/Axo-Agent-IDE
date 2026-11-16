import { create } from 'zustand';
import type { FileContent } from '@axo/protocol';
import {
  closeTab, openTab, parseTabs, removeFromTabs, renameInTabs, tabKey, targetKey,
  type EditorTab, type EditorTarget, type Tabs,
} from '../lib/editor-model.ts';
import { focusedSel, tryClient, useAxo } from './store.ts';

/** An open text file: what's on disk (`saved`, `mtime`) and what's in the editor (`content`). */
export interface Buffer {
  content: string;
  saved: string;
  mtime: number;
  language: string;
  /** Disk changed under unsaved edits, or the file vanished. */
  conflict: null | 'changed' | 'deleted';
}

interface EditorState extends Tabs {
  target: EditorTarget | null;
  buffers: Record<string, Buffer>; // by path
  /** Bumped to make the tree and git status refetch. */
  rev: number;
  quickOpen: boolean;

  setTarget(t: EditorTarget | null): void;
  open(tab: EditorTab): void;
  close(index: number): void;
  setActive(index: number): void;
  renamed(from: string, to: string): void;
  removed(path: string): void;
  loaded(path: string, file: FileContent): void;
  edit(path: string, content: string): void;
  saved(path: string, content: string, mtime: number): void;
  diskChanged(path: string, file: FileContent | null): void;
  bump(): void;
  setQuickOpen(v: boolean): void;
}

const KEY = 'axo.editor';
interface Persisted { target: EditorTarget | null; tabs: Record<string, Tabs> }
function readPersisted(): Persisted {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '');
    return { target: v?.target ?? null, tabs: v?.tabs && typeof v.tabs === 'object' ? v.tabs : {} };
  } catch {
    return { target: null, tabs: {} };
  }
}

export const isDirty = (b: Buffer | undefined) => !!b && b.content !== b.saved;

export const useEditor = create<EditorState>((set, get) => {
  const initial = readPersisted();
  const persist = () => {
    const s = get();
    const p = readPersisted();
    p.target = s.target;
    if (s.target) p.tabs[targetKey(s.target)] = { tabs: s.tabs, active: s.active };
    localStorage.setItem(KEY, JSON.stringify(p));
  };
  const setTabs = (t: Tabs) => { set(t); persist(); };
  const patchBuf = (path: string, fn: (b: Buffer) => Partial<Buffer>) =>
    set((s) => (s.buffers[path] ? { buffers: { ...s.buffers, [path]: { ...s.buffers[path], ...fn(s.buffers[path]) } } } : {}));

  return {
    target: initial.target,
    ...(initial.target ? parseTabs(initial.tabs[targetKey(initial.target)]) : { tabs: [], active: -1 }),
    buffers: {},
    rev: 0,
    quickOpen: false,

    setTarget(target) {
      const cur = get().target;
      if (cur && target && targetKey(cur) === targetKey(target)) return;
      persist();
      const tabs = target ? parseTabs(readPersisted().tabs[targetKey(target)]) : { tabs: [], active: -1 };
      set({ target, ...tabs, buffers: {}, rev: get().rev + 1 });
      persist();
    },
    open(tab) {
      const s = get();
      setTabs(openTab(s, tab, (t) => t.kind === 'file' && isDirty(s.buffers[t.path])));
    },
    close(index) {
      const s = get();
      const tab = s.tabs[index];
      const next = closeTab(s, index);
      // Drop the buffer unless another tab (e.g. its diff) still shows the path.
      if (tab && !next.tabs.some((t) => t.path === tab.path)) {
        const { [tab.path]: _, ...rest } = s.buffers;
        set({ buffers: rest });
      }
      setTabs(next);
    },
    setActive(index) { if (index >= 0 && index < get().tabs.length) setTabs({ tabs: get().tabs, active: index }); },
    renamed(from, to) {
      const s = get();
      const buffers: Record<string, Buffer> = {};
      for (const [p, b] of Object.entries(s.buffers)) buffers[p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p] = b;
      set({ buffers });
      setTabs(renameInTabs(s, from, to));
    },
    removed(path) {
      const s = get();
      const buffers = Object.fromEntries(Object.entries(s.buffers).filter(([p]) => p !== path && !p.startsWith(path + '/')));
      set({ buffers });
      setTabs(removeFromTabs(s, path));
    },
    loaded(path, file) {
      set((s) => ({ buffers: { ...s.buffers, [path]: { content: file.content ?? '', saved: file.content ?? '', mtime: file.mtime, language: file.language, conflict: null } } }));
    },
    edit(path, content) { patchBuf(path, () => ({ content })); },
    saved(path, content, mtime) { patchBuf(path, () => ({ saved: content, mtime, conflict: null })); },
    diskChanged(path, file) {
      const b = get().buffers[path];
      if (!b) return;
      if (!file) { patchBuf(path, () => ({ conflict: 'deleted' })); return; }
      if (file.mtime === b.mtime || file.content === null) return;
      if (isDirty(b)) patchBuf(path, () => ({ conflict: file.content === b.content ? null : 'changed' }));
      else patchBuf(path, () => ({ content: file.content!, saved: file.content!, mtime: file.mtime, conflict: null }));
    },
    bump() { set((s) => ({ rev: s.rev + 1 })); },
    setQuickOpen(quickOpen) { set({ quickOpen }); },
  };
});

export const activeTab = (s: Tabs): EditorTab | null => s.tabs[s.active] ?? null;
export { tabKey };

/** Default target: the focused agent's project (its team worktree if it has one), else the first project. */
export function defaultTarget(): EditorTarget | null {
  const s = useAxo.getState();
  const sel = focusedSel(s);
  const agent = sel ? s.nodes[sel.nodeKey]?.agents.find((a) => a.id === sel.agentId) : undefined;
  if (sel && agent) {
    const team = s.nodes[sel.nodeKey].teams.find((t) => t.id === agent.teamId);
    if (team?.worktreePath && agent.workdir !== team.worktreePath) return { nodeKey: sel.nodeKey, projectId: agent.projectId, team: null, agent: agent.id };
    return { nodeKey: sel.nodeKey, projectId: agent.projectId, team: team?.worktreePath ? team.id : null };
  }
  for (const k of s.nodeOrder) {
    const p = s.nodes[k].projects[0];
    if (p) return { nodeKey: k, projectId: p.id, team: null };
  }
  return null;
}

/** Query string for the file API (`path` + optional `team`). */
export function fileQuery(target: EditorTarget, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params);
  if (target.agent) q.set('agent', target.agent);
  else if (target.team) q.set('team', target.team);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** URL for <img>/<video>/pdf.js: tokens go in the query because media elements can't send headers. */
export function rawUrl(target: EditorTarget, path: string): string {
  const c = tryClient(target.nodeKey);
  if (!c) return '';
  const conn = c.conn;
  const q = new URLSearchParams({ path, token: conn.token });
  if (target.agent) q.set('agent', target.agent);
  else if (target.team) q.set('team', target.team);
  return `${conn.baseUrl}/api/projects/${target.projectId}/files/raw?${q}`;
}
