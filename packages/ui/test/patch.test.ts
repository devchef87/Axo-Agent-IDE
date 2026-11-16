import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { changeBar, parsePatch } from '../src/lib/patch.ts';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1..2 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,4 @@ function x() {',
  ' keep',
  '-old',
  '+new',
  '+more',
  ' tail',
  '\\ No newline at end of file',
  'diff --git a/img.png b/img.png',
  'new file mode 100644',
  'Binary files /dev/null and b/img.png differ',
  'diff --git a/old.md b/docs/new.md',
  'similarity index 90%',
  'rename from old.md',
  'rename to docs/new.md',
  '',
].join('\n');

describe('parsePatch', () => {
  const files = parsePatch(PATCH);
  it('splits files and detects status', () => {
    assert.deepEqual(files.map((f) => [f.path, f.status, f.binary]), [
      ['src/a.ts', 'modified', false], ['img.png', 'added', true], ['docs/new.md', 'renamed', false],
    ]);
    assert.equal(files[2].oldPath, 'old.md');
  });
  it('numbers old and new lines through a hunk', () => {
    const l = files[0].lines;
    assert.equal(l[0].type, 'hunk');
    assert.deepEqual(l.slice(1).map((x) => [x.type, x.oldNo, x.newNo]), [
      ['ctx', 10, 10], ['del', 11, null], ['add', null, 11], ['add', null, 12], ['ctx', 12, 13], ['note', null, null],
    ]);
    assert.equal(l[2].text, 'old');
  });
  it('ignores ---/+++ headers before the first hunk', () => {
    assert.ok(!files[0].lines.some((x) => x.text.startsWith('-- a/') || x.text.startsWith('++ b/')));
  });
});

describe('changeBar', () => {
  it('scales to the width', () => {
    assert.deepEqual(changeBar(0, 0), [0, 0]);
    assert.deepEqual(changeBar(2, 1), [2, 1]);
    assert.deepEqual(changeBar(100, 100), [3, 2]);
    assert.deepEqual(changeBar(10, 0), [5, 0]);
  });
});
