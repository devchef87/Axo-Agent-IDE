import type { Agent, Team } from '@axo/protocol';

export interface TeamGroup { team: Team | null; agents: Agent[] }

/**
 * A project's agents grouped by team, teams in creation order. Agents whose team is archived or
 * unknown land in a trailing `team: null` group. Teams without agents still show, so they can be
 * renamed and given agents.
 */
export function groupByTeam(projectId: string, agents: Agent[], teams: Team[]): TeamGroup[] {
  const active = teams.filter((t) => t.projectId === projectId && !t.archivedAt).sort((a, b) => a.createdAt - b.createdAt);
  const mine = agents.filter((a) => a.projectId === projectId);
  const groups: TeamGroup[] = active.map((team) => ({ team, agents: mine.filter((a) => a.teamId === team.id) }));
  const ids = new Set(active.map((t) => t.id));
  const loose = mine.filter((a) => !ids.has(a.teamId));
  if (loose.length) groups.push({ team: null, agents: loose });
  return groups;
}
