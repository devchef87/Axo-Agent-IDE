import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closeTab, fileKind, MAX_TABS, openTab, parseTabs, removeFromTabs, renameInTabs, selectionMessage, type Tabs } from '../src/lib/editor-model.ts';

const empty: Tabs = { tabs: [], active: -1 };
const f = (path: string) => ({ kind: 'file' as const, path });

describe('editor tabs', () => {
  it('opens after the active tab and focuses existing tabs', () => {
    let s = openTab(empty, f('a'));
    s = openTab(s, f('b'));
    s = { ...s, active: 0 };
    s = openTab(s, f('c'));
    assert.deepEqual(s.tabs.map((t) => t.path), ['a', 'c', 'b']);
    assert.equal(s.active, 1);
    assert.equal(openTab(s, f('b')).active, 2);
    assert.equal(openTab(s, { kind: 'diff', path: 'b' }).tabs.length, 4, 'a diff is its own tab');
  });

  it('evicts the oldest clean tab past the limit, never a dirty one', () => {
    let s = empty;
    for (let i = 0; i < MAX_TABS; i++) s = openTab(s, f(`f${i}`));
    s = openTab(s, f('new'), (t) => t.path === 'f0');
    assert.equal(s.tabs.length, MAX_TABS);
    assert.ok(s.tabs.some((t) => t.path === 'f0'), 'dirty tab kept');
    assert.ok(!s.tabs.some((t) => t.path === 'f1'), 'oldest clean tab evicted');
    assert.equal(s.tabs[s.active].path, 'new');
  });

  it('closing moves focus to a neighbour', () => {
    const s: Tabs = { tabs: [f('a'), f('b'), f('c')], active: 2 };
    assert.equal(closeTab(s, 2).active, 1);
    assert.equal(closeTab(s, 0).active, 1);
    assert.deepEqual(closeTab({ tabs: [f('a')], active: 0 }, 0), empty);
  });

  it('follows renames and deletes, including folders', () => {
    const s: Tabs = { tabs: [f('src/a.ts'), f('src/sub/b.ts'), f('srcx.ts')], active: 2 };
    assert.deepEqual(renameInTabs(s, 'src', 'lib').tabs.map((t) => t.path), ['lib/a.ts', 'lib/sub/b.ts', 'srcx.ts']);
    const r = removeFromTabs(s, 'src');
    assert.deepEqual(r.tabs.map((t) => t.path), ['srcx.ts']);
    assert.equal(r.active, 0);
  });

  it('parses persisted tabs defensively', () => {
    assert.deepEqual(parseTabs(null), empty);
    assert.deepEqual(parseTabs({ tabs: [f('a'), { kind: 'bad', path: 'x' }, 7], active: 5 }), { tabs: [f('a')], active: 0 });
  });
});

describe('files', () => {
  it('classifies by extension', () => {
    assert.equal(fileKind('a/b.PNG'), 'image');
    assert.equal(fileKind('clip.mov'), 'video');
    assert.equal(fileKind('doc.pdf'), 'pdf');
    assert.equal(fileKind('Makefile'), 'text');
  });
  it('formats a selection for an agent', () => {
    assert.equal(selectionMessage('src/a.ts', 3, 4, 'x\ny\n', 'typescript'), '`src/a.ts:L3-4`\n```typescript\nx\ny\n```\n');
    assert.ok(selectionMessage('a.md', 1, 1, '```js\n```', 'markdown').includes('````markdown'));
  });
});
