import * as Haptics from 'expo-haptics';
import type { Agent, Team } from '@axo/protocol';
import { useAxo } from '../lib/store.ts';
import { showDialog } from './dialog.tsx';

// Destructive actions, always behind a themed confirm. Used from the drawer (long-press) and the chat header.

export function confirmDeleteAgent(nodeKey: string, agent: Agent): void {
  showDialog(`Delete ${agent.name}?`, 'Its process is stopped and its chat history is deleted. This can\'t be undone.', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Delete', style: 'destructive',
      onPress: () => {
        useAxo.getState().deleteAgent(nodeKey, agent.id).then(
          () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
          (e) => showDialog(`Couldn't delete ${agent.name}`, e?.message ?? String(e)),
        );
      },
    },
  ]);
}

/** Deleting a team archives it on the node: agents are stopped and hidden, its worktree removed if clean, the branch kept. */
export function confirmDeleteTeam(nodeKey: string, team: Team, agents: number): void {
  const who = agents === 1 ? 'Its agent is stopped' : agents ? `Its ${agents} agents are stopped` : 'It';
  const branch = team.branch ? ` The branch ${team.branch} is kept.` : '';
  showDialog(`Delete team ${team.name}?`, `${who}${agents ? ' and hidden' : ' is hidden'}.${branch}`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => archive(nodeKey, team, true) },
  ]);
}

function archive(nodeKey: string, team: Team, removeWorktree: boolean): void {
  useAxo.getState().deleteTeam(nodeKey, team.id, removeWorktree).then(
    () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    (e) => {
      const msg = String(e?.message ?? e);
      if (removeWorktree && /uncommitted changes/i.test(msg)) {
        // The node won't remove a worktree with uncommitted work; offer to delete the team and leave the folder alone.
        showDialog(`${team.name} has uncommitted changes`, 'Delete the team anyway and keep its worktree folder (with the changes) on the server?', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete, keep folder', style: 'destructive', onPress: () => archive(nodeKey, team, false) },
        ]);
      } else {
        showDialog(`Couldn't delete ${team.name}`, msg);
      }
    },
  );
}
