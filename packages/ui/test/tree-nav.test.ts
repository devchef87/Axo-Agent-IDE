import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { treeNav, type NavRow } from '../src/lib/tree-nav.ts';

const rows: NavRow[] = [
  { level: 1, expanded: true, label: 'Local' },
  { level: 2, expanded: true, label: 'Axo' },
  { level: 3, expanded: null, label: 'backend-1' },
  { level: 3, expanded: null, label: 'ui-1' },
  { level: 2, expanded: false, label: 'website' },
];

describe('treeNav', () => {
  it('moves with arrows, Home and End, clamped', () => {
    assert.deepEqual(treeNav(rows, 2, 'ArrowDown'), { focus: 3 });
    assert.deepEqual(treeNav(rows, 4, 'ArrowDown'), { focus: 4 });
    assert.deepEqual(treeNav(rows, 0, 'ArrowUp'), { focus: 0 });
    assert.deepEqual(treeNav(rows, 2, 'End'), { focus: 4 });
    assert.deepEqual(treeNav(rows, 3, 'Home'), { focus: 0 });
  });
  it('right expands a closed row, or enters an open one', () => {
    assert.deepEqual(treeNav(rows, 4, 'ArrowRight'), { toggle: 4 });
    assert.deepEqual(treeNav(rows, 1, 'ArrowRight'), { focus: 2 });
    assert.equal(treeNav(rows, 2, 'ArrowRight'), null);
  });
  it('left collapses an open row, otherwise goes to the parent', () => {
    assert.deepEqual(treeNav(rows, 1, 'ArrowLeft'), { toggle: 1 });
    assert.deepEqual(treeNav(rows, 3, 'ArrowLeft'), { focus: 1 });
    assert.deepEqual(treeNav(rows, 4, 'ArrowLeft'), { focus: 0 });
  });
  it('typeahead finds the next match and wraps', () => {
    assert.deepEqual(treeNav(rows, 0, 'u'), { focus: 3 });
    assert.deepEqual(treeNav(rows, 3, 'b'), { focus: 2 });
    assert.equal(treeNav(rows, 0, 'z'), null);
    assert.equal(treeNav(rows, 0, ' '), null);
  });
});
