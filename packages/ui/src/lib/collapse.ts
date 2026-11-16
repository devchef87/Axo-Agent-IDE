// When to fold long text in the feed, and what to show folded. Pure and unit-tested.

export interface Folded { head: string; hiddenLines: number; totalLines: number }

/**
 * Text longer than `maxLines` lines (or `maxChars` characters) is folded to its first `keepLines`
 * lines. Returns null when it's short enough to show in full.
 */
export function foldText(text: string, { maxLines = 18, keepLines = 10, maxChars = 4000 } = {}): Folded | null {
  const lines = text.split('\n');
  if (lines.length <= maxLines && text.length <= maxChars) return null;
  let head = lines.slice(0, keepLines).join('\n');
  if (head.length > maxChars / 2) head = head.slice(0, maxChars / 2) + '…';
  return { head, hiddenLines: Math.max(0, lines.length - keepLines), totalLines: lines.length };
}
