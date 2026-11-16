import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Team } from '@axo/protocol';
import { groupByTeam } from '../src/lib/team-groups.ts';

const team = (id: string, createdAt: number, extra: Partial<Team> = {}): Team =>
  ({ id, projectId: 'p', name: id, mode: 'shared', branch: null, worktreePath: null, createdAt, archivedAt: null, ...extra });
const agent = (id: string, teamId: string, projectId = 'p') => ({ id, teamId, projectId, name: id }) as Agent;

describe('groupByTeam', () => {
  it('groups agents under their team, teams oldest first, empty teams kept', () => {
    const g = groupByTeam('p', [agent('a', 't2'), agent('b', 't1'), agent('c', 't2')], [team('t2', 2), team('t1', 1), team('t3', 3)]);
    assert.deepEqual(g.map((x) => [x.team?.id, x.agents.map((a) => a.id)]), [['t1', ['b']], ['t2', ['a', 'c']], ['t3', []]]);
  });

  it('puts agents of archived or unknown teams in a trailing group and ignores other projects', () => {
    const g = groupByTeam('p', [agent('a', 'gone'), agent('b', 'old'), agent('x', 't1', 'q')], [team('t1', 1), team('old', 0, { archivedAt: 5 })]);
    assert.deepEqual(g.map((x) => [x.team?.id ?? null, x.agents.map((a) => a.id)]), [['t1', []], [null, ['a', 'b']]]);
  });
});
