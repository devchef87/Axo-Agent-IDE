import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TerminalInfo } from '@axo/protocol';
import { cwdLabel, nextActive, reconcile, tabFromInfo, termKey } from '../src/lib/terminal-model.ts';

const info = (id: string, createdAt: number, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id, cwd: `/work/${id}`, shell: '/bin/zsh', pid: 1, createdAt, cols: 80, rows: 24, exited: false, exitCode: null, attached: 0, ...extra,
});

describe('terminal tabs', () => {
  it('adopts live sessions after a reload, in the remembered order', () => {
    const order = [termKey('local', 'b'), termKey('local', 'a')];
    const tabs = reconcile([], 'local', [info('a', 1), info('b', 2), info('c', 3)], order);
    assert.deepEqual(tabs.map((t) => t.id), ['b', 'a', 'c']);
  });

  it('drops tabs whose session is gone, only for that node', () => {
    const tabs = [tabFromInfo('local', info('a', 1)), tabFromInfo('spark', info('x', 1)), tabFromInfo('local', info('b', 2))];
    const out = reconcile(tabs, 'local', [info('b', 2)]);
    assert.deepEqual(out.map((t) => t.key), ['spark:x', 'local:b']);
  });

  it('does not adopt exited sessions but keeps an open tab that exited', () => {
    const tabs = [tabFromInfo('local', info('a', 1))];
    const out = reconcile(tabs, 'local', [info('a', 1, { exited: true, exitCode: 0 }), info('z', 5, { exited: true, exitCode: 1 })]);
    assert.deepEqual(out.map((t) => [t.id, t.exited, t.exitCode]), [['a', true, 0]]);
  });

  it('picks the right neighbour, then the left, after closing', () => {
    const tabs = ['a', 'b', 'c'].map((id, i) => tabFromInfo('local', info(id, i)));
    assert.equal(nextActive(tabs, 'local:b'), 'local:c');
    assert.equal(nextActive(tabs, 'local:c'), 'local:b');
    assert.equal(nextActive(tabs.slice(0, 1), 'local:a'), null);
  });

  it('labels folders by their last segment and home as ~', () => {
    assert.equal(cwdLabel('/Users/rok'), '~');
    assert.equal(cwdLabel('/home/axom/'), '~');
    assert.equal(cwdLabel('/Users/rok/Desktop/Axo'), 'Axo');
    assert.equal(cwdLabel('/'), '/');
  });
});
