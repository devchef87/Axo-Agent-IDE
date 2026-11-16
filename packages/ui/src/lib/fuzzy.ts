// Small subsequence matcher for the command palette. Returns null for no match;
// higher scores are better. Rewards contiguous runs, word starts and early matches.

export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct !== -1) return 1000 - direct * 2 + (direct === 0 || /[\s/_.-]/.test(t[direct - 1]) ? 200 : 0) - t.length * 0.1;

  let score = 0, ti = 0, run = 0;
  for (const ch of q) {
    if (ch === ' ') { run = 0; continue; }
    const at = t.indexOf(ch, ti);
    if (at === -1) return null;
    const wordStart = at === 0 || /[\s/_.-]/.test(t[at - 1]);
    run = at === ti ? run + 1 : 0;
    score += 10 + run * 5 + (wordStart ? 15 : 0) - Math.min(at - ti, 10);
    ti = at + 1;
  }
  return score - t.length * 0.1;
}

/** Filter and rank by `fuzzyScore` over `key(item)`, stable for ties. */
export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string): T[] {
  if (!query.trim()) return items;
  return items
    .map((item, i) => ({ item, i, s: fuzzyScore(query, key(item)) }))
    .filter((x): x is { item: T; i: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}
