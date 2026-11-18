import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitSections } from '../src/lib/sections.ts';

describe('splitSections', () => {
  it('splits at headings, keeping any intro as its own section', () => {
    assert.deepEqual(splitSections('Intro.\n\n## A\none\n### B\ntwo'), ['Intro.\n', '## A\none', '### B\ntwo']);
  });
  it('starts with a heading without an empty first section', () => {
    assert.deepEqual(splitSections('# Plan\nx\n## Next\ny'), ['# Plan\nx', '## Next\ny']);
  });
  it('ignores # lines inside code fences and #### headings', () => {
    const md = 'Run:\n```sh\n# not a heading\n```\n#### small\nz';
    assert.deepEqual(splitSections(md), [md]);
  });
  it('returns the text unchanged when there are no headings', () => {
    assert.deepEqual(splitSections('just text'), ['just text']);
  });
});
