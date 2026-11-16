import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyFilter, fuzzyScore } from '../src/lib/fuzzy.ts';

describe('palette fuzzy match', () => {
  it('matches substrings and subsequences, rejects non-matches', () => {
    assert.equal(fuzzyScore('xyz', 'backend-1'), null);
    assert.ok(fuzzyScore('be1', 'backend-1') !== null);
    assert.equal(fuzzyScore('', 'anything'), 0);
  });
  it('ranks prefix and word-start matches first', () => {
    const items = ['Toggle theme', 'ui-1  Local / Axo', 'backend-1  Local / Axo', 'New agent'];
    assert.equal(fuzzyFilter(items, 'ui', (x) => x)[0], 'ui-1  Local / Axo');
    assert.equal(fuzzyFilter(items, 'na', (x) => x)[0], 'New agent');
    assert.deepEqual(fuzzyFilter(items, 'zzz', (x) => x), []);
  });
});
