// Editor tab rules and file classification. Pure (no DOM, no store) so they are unit-testable.

/** Files root: the project, a team worktree (`team`), or an agent's own worktree (`agent`). */
export interface EditorTarget { nodeKey: string; projectId: string; team: string | null; agent?: string | null }
export type TabKind = 'file' | 'diff';
export interface EditorTab { kind: TabKind; path: string }
export interface Tabs { tabs: EditorTab[]; active: number } // active = -1 when empty

export const MAX_TABS = 20;
export const tabKey = (t: EditorTab) => `${t.kind}:${t.path}`;
export const targetKey = (t: EditorTarget) => `${t.nodeKey}:${t.projectId}:${t.team ?? ''}${t.agent ? `:a:${t.agent}` : ''}`;

/** Open (or focus) a tab, inserted after the active one. Evicts the oldest clean tab past MAX_TABS. */
export function openTab(s: Tabs, tab: EditorTab, isDirty: (t: EditorTab) => boolean = () => false): Tabs {
  const at = s.tabs.findIndex((t) => tabKey(t) === tabKey(tab));
  if (at !== -1) return { ...s, active: at };
  const tabs = s.tabs.slice();
  const insert = s.active === -1 ? tabs.length : s.active + 1;
  tabs.splice(insert, 0, tab);
  let active = insert;
  while (tabs.length > MAX_TABS) {
    const victim = tabs.findIndex((t, i) => i !== active && !isDirty(t));
    if (victim === -1) break;
    tabs.splice(victim, 1);
    if (victim < active) active--;
  }
  return { tabs, active };
}

export function closeTab(s: Tabs, index: number): Tabs {
  if (index < 0 || index >= s.tabs.length) return s;
  const tabs = s.tabs.filter((_, i) => i !== index);
  let active = s.active;
  if (index < active) active--;
  else if (index === active) active = Math.min(index, tabs.length - 1);
  return { tabs, active: tabs.length ? active : -1 };
}

/** Rename/move: retarget tabs under `from` (a file or a folder). */
export function renameInTabs(s: Tabs, from: string, to: string): Tabs {
  const move = (p: string) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
  return { ...s, tabs: s.tabs.map((t) => ({ ...t, path: move(t.path) })) };
}

/** Delete: drop tabs for `path` and anything under it. */
export function removeFromTabs(s: Tabs, path: string): Tabs {
  let out = s;
  for (let i = out.tabs.length - 1; i >= 0; i--) {
    const p = out.tabs[i].path;
    if (p === path || p.startsWith(path + '/')) out = closeTab(out, i);
  }
  return out;
}

export function parseTabs(raw: unknown): Tabs {
  const v = raw as Partial<Tabs> | null;
  if (!v || !Array.isArray(v.tabs)) return { tabs: [], active: -1 };
  const tabs = v.tabs
    .filter((t): t is EditorTab => !!t && typeof t.path === 'string' && (t.kind === 'file' || t.kind === 'diff'))
    .slice(0, MAX_TABS)
    .map((t) => ({ kind: t.kind, path: t.path }));
  const active = Number.isInteger(v.active) && (v.active as number) >= 0 && (v.active as number) < tabs.length ? (v.active as number) : tabs.length ? 0 : -1;
  return { tabs, active };
}

export type FileKind = 'text' | 'image' | 'video' | 'audio' | 'pdf';
const KINDS: Record<string, FileKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image', ico: 'image', bmp: 'image',
  mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', ogv: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio',
  pdf: 'pdf',
};
export function fileKind(path: string): FileKind {
  const ext = path.split('/').pop()!.split('.').pop()!.toLowerCase();
  return KINDS[ext] ?? 'text';
}

export const basename = (p: string) => p.split('/').pop() ?? p;
export const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Context sent to an agent from an editor selection. */
export function selectionMessage(path: string, fromLine: number, toLine: number, text: string, language: string): string {
  const range = fromLine === toLine ? `L${fromLine}` : `L${fromLine}-${toLine}`;
  const fence = text.includes('```') ? '````' : '```';
  return `\`${path}:${range}\`\n${fence}${language === 'text' ? '' : language}\n${text.replace(/\n$/, '')}\n${fence}\n`;
}
