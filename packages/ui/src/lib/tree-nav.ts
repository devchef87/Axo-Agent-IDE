// Keyboard rules for a tree list (the sidebar). Pure: maps the visible rows plus a key to
// an action, so it's unit-testable without a DOM.

export interface NavRow { level: number; expanded: boolean | null; label: string } // expanded null = leaf
export type NavAction = { focus: number } | { toggle: number } | null;

export function treeNav(rows: NavRow[], current: number, key: string): NavAction {
  if (!rows.length) return null;
  const cur = Math.max(0, Math.min(current, rows.length - 1));
  const row = rows[cur];
  switch (key) {
    case 'ArrowDown': return { focus: Math.min(cur + 1, rows.length - 1) };
    case 'ArrowUp': return { focus: Math.max(cur - 1, 0) };
    case 'Home': return { focus: 0 };
    case 'End': return { focus: rows.length - 1 };
    case 'ArrowRight':
      if (row.expanded === false) return { toggle: cur };
      if (row.expanded === true && rows[cur + 1]?.level > row.level) return { focus: cur + 1 };
      return null;
    case 'ArrowLeft': {
      if (row.expanded === true) return { toggle: cur };
      for (let i = cur - 1; i >= 0; i--) if (rows[i].level < row.level) return { focus: i };
      return null;
    }
    default: {
      // Typeahead: next row (after the current one, wrapping) whose label starts with the key.
      if (key.length !== 1 || !/\S/.test(key)) return null;
      const k = key.toLowerCase();
      for (let n = 1; n <= rows.length; n++) {
        const i = (cur + n) % rows.length;
        if (rows[i].label.toLowerCase().startsWith(k)) return { focus: i };
      }
      return null;
    }
  }
}
