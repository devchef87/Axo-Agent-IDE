import type { FeedItem } from '@axo/protocol';
import type { Preview } from './store.ts';

// Pure helpers for the chat: grouping, folding, previews. Mirrors packages/ui (feed.tsx, lib/collapse.ts).

export type ToolItem = Extract<FeedItem, { kind: 'tool' }>;
export type Block =
  | { type: 'item'; id: string; item: FeedItem }
  | { type: 'tools'; id: string; items: ToolItem[] }
  | { type: 'draft'; id: string; text: string };

/** Consecutive tool calls collapse into one block; streamed drafts go last. */
export function toBlocks(items: FeedItem[], drafts: Record<string, string>): Block[] {
  const out: Block[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.kind === 'tool') {
      if (last?.type === 'tools') last.items.push(item);
      else out.push({ type: 'tools', id: `g-${item.id}`, items: [item] });
    } else {
      out.push({ type: 'item', id: item.id, item });
    }
  }
  for (const [id, text] of Object.entries(drafts)) out.push({ type: 'draft', id: `d-${id}`, text });
  return out;
}

export interface Folded { head: string; hiddenLines: number; totalLines: number }

/** Text longer than `maxLines` lines (or `maxChars`) folds to its first `keepLines`. Null when short enough. */
export function foldText(text: string, { maxLines = 14, keepLines = 8, maxChars = 2400 } = {}): Folded | null {
  const lines = text.split('\n');
  if (lines.length <= maxLines && text.length <= maxChars) return null;
  let head = lines.slice(0, keepLines).join('\n');
  if (head.length > maxChars / 2) head = head.slice(0, maxChars / 2) + '…';
  return { head, hiddenLines: Math.max(0, lines.length - keepLines), totalLines: lines.length };
}

export type Sender = 'you' | 'watch' | 'axo' | 'agent';
export function senderOf(author: string): Sender {
  if (author === 'user') return 'you';
  if (author === 'watch') return 'watch';
  if (author === 'axo') return 'axo';
  return 'agent'; // InnerChat: another agent's name
}

/** One line for the drawer: the latest prose or message. */
export function previewOf(item: FeedItem): Preview | null {
  if (item.kind !== 'text' && item.kind !== 'user') return null;
  const text = item.text.replace(/[#*_`>\[\]]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (!text) return null;
  return { text, ts: item.ts, author: item.kind === 'user' ? item.author : undefined };
}

const VERB: Record<string, string> = {
  Bash: 'Ran', Read: 'Read', Write: 'Wrote', Edit: 'Edited', MultiEdit: 'Edited', Glob: 'Searched', Grep: 'Searched',
  WebFetch: 'Fetched', WebSearch: 'Searched web', TodoWrite: 'Updated todos', Task: 'Delegated', Agent: 'Delegated',
};
export const verbOf = (tool: string) => VERB[tool] ?? tool;

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
