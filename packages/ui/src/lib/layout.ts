// Fleet pane layout: 1–3 chat panes side by side. Pure functions (no DOM, no store)
// so the rules are unit-testable; the store persists the result.

export interface Selection { nodeKey: string; agentId: string }

export interface Layout {
  panes: (Selection | null)[]; // 1..MAX_PANES; null = empty pane
  sizes: number[];             // fractions, same length as panes, sum 1
  focused: number;             // index into panes
}

export const MAX_PANES = 3;
export const MIN_FRACTION = 0.18;

export const sameSel = (a: Selection | null | undefined, b: Selection | null | undefined) =>
  !!a && !!b && a.nodeKey === b.nodeKey && a.agentId === b.agentId;

const equal = (n: number) => Array.from({ length: n }, () => 1 / n);

export const emptyLayout = (): Layout => ({ panes: [null], sizes: [1], focused: 0 });

/** Show `sel` in pane `index` (default: focused). If it is already open elsewhere, focus that pane instead. */
export function openIn(l: Layout, sel: Selection, index = l.focused): Layout {
  const existing = l.panes.findIndex((p) => sameSel(p, sel));
  if (existing !== -1) return { ...l, focused: existing };
  const i = Math.max(0, Math.min(index, l.panes.length - 1));
  const panes = l.panes.slice();
  panes[i] = sel;
  return { ...l, panes, focused: i };
}

/**
 * Open `sel` in a new split to the right of `after` (default: the last pane).
 * At MAX_PANES, it replaces the rightmost non-focused pane, so the pane you are
 * looking at never changes under you.
 */
export function openInSplit(l: Layout, sel: Selection, after = l.panes.length - 1): Layout {
  const existing = l.panes.findIndex((p) => sameSel(p, sel));
  if (existing !== -1) return { ...l, focused: existing };
  // An empty pane is the obvious place for it.
  const empty = l.panes.findIndex((p) => p === null);
  if (empty !== -1) return openIn(l, sel, empty);
  if (l.panes.length >= MAX_PANES) {
    let target = l.panes.length - 1;
    if (target === l.focused) target--;
    return openIn(l, sel, target);
  }
  const at = Math.max(0, Math.min(after, l.panes.length - 1)) + 1;
  const panes = l.panes.slice();
  panes.splice(at, 0, sel);
  return { panes, sizes: equal(panes.length), focused: at };
}

export function closePane(l: Layout, index: number): Layout {
  if (index < 0 || index >= l.panes.length) return l;
  if (l.panes.length === 1) return emptyLayout();
  const panes = l.panes.filter((_, i) => i !== index);
  // Give the closed pane's space to its neighbours proportionally.
  const rest = l.sizes.filter((_, i) => i !== index);
  const total = rest.reduce((a, b) => a + b, 0);
  const sizes = rest.map((s) => s / total);
  const focused = l.focused > index ? l.focused - 1 : Math.min(l.focused, panes.length - 1);
  return { panes, sizes, focused };
}

/** Remove an agent from every pane (it was deleted). Empty panes collapse, but at least one remains. */
export function dropAgent(l: Layout, sel: Selection): Layout {
  let out = l;
  for (let i = out.panes.length - 1; i >= 0; i--) {
    if (!sameSel(out.panes[i], sel)) continue;
    if (out.panes.length > 1) out = closePane(out, i);
    else out = { ...out, panes: [null] };
  }
  return out;
}

/** Move the divider between pane `i` and `i + 1` by `delta` (fraction of total width). */
export function resize(l: Layout, i: number, delta: number): Layout {
  if (i < 0 || i >= l.sizes.length - 1) return l;
  const pair = l.sizes[i] + l.sizes[i + 1];
  const left = Math.max(MIN_FRACTION, Math.min(pair - MIN_FRACTION, l.sizes[i] + delta));
  const sizes = l.sizes.slice();
  sizes[i] = left;
  sizes[i + 1] = pair - left;
  return { ...l, sizes };
}

export const resetSizes = (l: Layout): Layout => ({ ...l, sizes: equal(l.panes.length) });

/** Parse persisted layout defensively; anything odd falls back to a sane layout. */
export function parseLayout(raw: string | null): Layout {
  try {
    const v = JSON.parse(raw ?? '');
    const isSel = (p: any) => p === null || (p && typeof p.nodeKey === 'string' && typeof p.agentId === 'string');
    if (!Array.isArray(v?.panes) || v.panes.length < 1 || v.panes.length > MAX_PANES || !v.panes.every(isSel)) return emptyLayout();
    const panes: (Selection | null)[] = v.panes.map((p: any) => (p ? { nodeKey: p.nodeKey, agentId: p.agentId } : null));
    let sizes: number[] = Array.isArray(v.sizes) && v.sizes.length === panes.length && v.sizes.every((s: any) => typeof s === 'number' && s > 0)
      ? v.sizes : equal(panes.length);
    const total = sizes.reduce((a, b) => a + b, 0);
    sizes = sizes.map((s) => s / total);
    if (sizes.some((s) => s < MIN_FRACTION - 1e-6)) sizes = equal(panes.length);
    const focused = Number.isInteger(v.focused) && v.focused >= 0 && v.focused < panes.length ? v.focused : 0;
    return { panes, sizes, focused };
  } catch {
    return emptyLayout();
  }
}
