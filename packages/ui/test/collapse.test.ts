import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { foldText } from '../src/lib/collapse.ts';

describe('foldText', () => {
  it('leaves short text alone', () => {
    assert.equal(foldText('a\nb\nc'), null);
  });
  it('folds long text to the first lines', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const f = foldText(text)!;
    assert.equal(f.totalLines, 40);
    assert.equal(f.hiddenLines, 30);
    assert.equal(f.head.split('\n').length, 10);
    assert.ok(f.head.startsWith('line 0'));
  });
  it('folds a single huge line by characters', () => {
    const f = foldText('x'.repeat(10_000))!;
    assert.ok(f);
    assert.ok(f.head.length <= 2001);
  });
});
