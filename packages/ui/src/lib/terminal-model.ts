import type { TerminalInfo } from '@axo/protocol';

/** One terminal tab: a PTY session on a node. key = `${nodeKey}:${id}`. */
export interface TermTab {
  key: string;
  nodeKey: string;
  id: string;
  cwd: string;
  exited: boolean;
  exitCode: number | null;
}

export const termKey = (nodeKey: string, id: string) => `${nodeKey}:${id}`;

export function tabFromInfo(nodeKey: string, t: TerminalInfo): TermTab {
  return { key: termKey(nodeKey, t.id), nodeKey, id: t.id, cwd: t.cwd, exited: t.exited, exitCode: t.exitCode };
}

/**
 * Merge a node's live session list into the tabs. Tabs for that node whose session is gone are
 * dropped; live sessions we don't have yet (opened before a reload) are adopted, in the order
 * remembered from last time (`order`), then by creation time. Exited sessions are not adopted.
 */
export function reconcile(tabs: TermTab[], nodeKey: string, list: TerminalInfo[], order: string[] = []): TermTab[] {
  const live = new Map(list.map((t) => [termKey(nodeKey, t.id), t]));
  const kept = tabs
    .filter((t) => t.nodeKey !== nodeKey || live.has(t.key))
    .map((t) => {
      const info = t.nodeKey === nodeKey ? live.get(t.key) : undefined;
      return info ? { ...t, cwd: info.cwd, exited: t.exited || info.exited, exitCode: t.exitCode ?? info.exitCode } : t;
    });
  const have = new Set(kept.map((t) => t.key));
  const adopted = list
    .filter((t) => !t.exited && !have.has(termKey(nodeKey, t.id)))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((t) => tabFromInfo(nodeKey, t));
  // Remembered order first; anything new keeps its place after (sort is stable).
  const rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
  return [...kept, ...adopted].sort((a, b) => rank(a.key) - rank(b.key));
}

/** Last path segment, with the home directory shown as ~. */
export function cwdLabel(cwd: string): string {
  if (/^\/(Users|home)\/[^/]+\/?$/.test(cwd) || cwd === '/root') return '~';
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '/';
}

/** The tab to show after closing `key`: the right neighbour, else the left one. */
export function nextActive(tabs: TermTab[], key: string): string | null {
  const i = tabs.findIndex((t) => t.key === key);
  if (i < 0) return tabs[0]?.key ?? null;
  return tabs[i + 1]?.key ?? tabs[i - 1]?.key ?? null;
}
