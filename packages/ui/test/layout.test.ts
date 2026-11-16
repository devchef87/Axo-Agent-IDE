import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  closePane, dropAgent, emptyLayout, MAX_PANES, MIN_FRACTION, openIn, openInSplit, parseLayout, resize, type Layout,
} from '../src/lib/layout.ts';

const A = { nodeKey: 'local', agentId: 'a' };
const B = { nodeKey: 'local', agentId: 'b' };
const C = { nodeKey: 'prod', agentId: 'c' };
const D = { nodeKey: 'prod', agentId: 'd' };
const sum = (l: Layout) => l.sizes.reduce((a, b) => a + b, 0);

describe('fleet layout', () => {
  it('opens in the focused pane, or focuses an existing pane', () => {
    let l = openIn(emptyLayout(), A);
    assert.deepEqual(l.panes, [A]);
    l = openInSplit(l, B);
    assert.equal(l.focused, 1);
    l = openIn(l, A);
    assert.equal(l.focused, 0, 'already open: focus, do not duplicate');
    assert.deepEqual(l.panes, [A, B]);
  });

  it('splits up to MAX_PANES with equal sizes, then replaces a non-focused pane', () => {
    let l = openInSplit(openInSplit(openIn(emptyLayout(), A), B), C);
    assert.equal(l.panes.length, MAX_PANES);
    assert.ok(l.sizes.every((s) => Math.abs(s - 1 / 3) < 1e-9));
    assert.equal(l.focused, 2);
    l = openInSplit(l, D);
    assert.deepEqual(l.panes, [A, D, C], 'the focused (rightmost) pane is kept');
    assert.equal(l.focused, 1);
  });

  it('fills an empty pane before splitting', () => {
    const l = openInSplit(emptyLayout(), A);
    assert.deepEqual(l.panes, [A]);
  });

  it('closing a pane redistributes its space and keeps focus sensible', () => {
    let l = openInSplit(openInSplit(openIn(emptyLayout(), A), B), C);
    l = resize(l, 0, 0.1);
    l = closePane(l, 0);
    assert.deepEqual(l.panes, [B, C]);
    assert.ok(Math.abs(sum(l) - 1) < 1e-9);
    assert.equal(l.focused, 1, 'C stays focused');
    assert.deepEqual(closePane(openIn(emptyLayout(), A), 0), emptyLayout());
  });

  it('resizing clamps to MIN_FRACTION and keeps the pair total', () => {
    let l = openInSplit(openIn(emptyLayout(), A), B);
    l = resize(l, 0, 5);
    assert.ok(Math.abs(l.sizes[1] - MIN_FRACTION) < 1e-9);
    assert.ok(Math.abs(sum(l) - 1) < 1e-9);
    assert.equal(resize(l, 1, 0.1), l, 'no divider after the last pane');
  });

  it('a deleted agent leaves every pane, keeping at least one', () => {
    let l = openInSplit(openIn(emptyLayout(), A), B);
    l = dropAgent(l, A);
    assert.deepEqual(l.panes, [B]);
    l = dropAgent(l, B);
    assert.deepEqual(l.panes, [null]);
  });

  it('parses persisted layouts defensively', () => {
    assert.deepEqual(parseLayout(null), emptyLayout());
    assert.deepEqual(parseLayout('garbage'), emptyLayout());
    assert.deepEqual(parseLayout(JSON.stringify({ panes: [A, B, C, D] })), emptyLayout());
    const l = parseLayout(JSON.stringify({ panes: [A, null], sizes: [3, 1], focused: 9 }));
    assert.deepEqual(l.panes, [A, null]);
    assert.deepEqual(l.sizes, [0.75, 0.25]);
    assert.equal(l.focused, 0);
    assert.deepEqual(parseLayout(JSON.stringify({ panes: [A, B], sizes: [0.99, 0.01] })).sizes, [0.5, 0.5]);
  });
});
