// Watches from every node, kept live by watch:upsert / watch:removed. Synced once from App.
import { useEffect } from 'react';
import { create } from 'zustand';
import type { Watch } from '@axo/protocol';
import { onNodeEvent, useAxo } from './store.ts';

export interface WatchRow { nodeKey: string; watch: Watch }

export const useWatchStore = create<{ byNode: Record<string, Watch[]> }>(() => ({ byNode: {} }));

const patch = (k: string, fn: (list: Watch[]) => Watch[]) =>
  useWatchStore.setState((s) => ({ byNode: { ...s.byNode, [k]: fn(s.byNode[k] ?? []) } }));

/** Mount once: loads each online node's watches and applies live events. */
export function useWatchSync(): void {
  const online = useAxo((s) => s.nodeOrder.filter((k) => s.nodes[k].status === 'online').join(','));
  const client = useAxo((s) => s.client);

  useEffect(() => {
    const keys = online.split(',').filter(Boolean);
    // Forget nodes that went away.
    useWatchStore.setState((s) => ({ byNode: Object.fromEntries(Object.entries(s.byNode).filter(([k]) => keys.includes(k))) }));
    for (const k of keys) client(k).get<Watch[]>('/watches').then((list) => patch(k, () => list), () => {});
  }, [online, client]);

  useEffect(() => onNodeEvent((k, ev) => {
    if (ev.type === 'watch:upsert') {
      patch(k, (list) => {
        const i = list.findIndex((w) => w.id === ev.watch.id);
        return i === -1 ? [ev.watch, ...list] : list.map((w, j) => (j === i ? ev.watch : w));
      });
    } else if (ev.type === 'watch:removed') {
      patch(k, (list) => list.filter((w) => w.id !== ev.watchId));
    }
  }), []);
}

export function watchRows(byNode: Record<string, Watch[]>): WatchRow[] {
  return Object.entries(byNode)
    .flatMap(([nodeKey, list]) => list.map((watch) => ({ nodeKey, watch })))
    .sort((a, b) => b.watch.createdAt - a.watch.createdAt);
}

export function useActiveWatchCount(): number {
  return useWatchStore((s) => Object.values(s.byNode).reduce((n, list) => n + list.filter((w) => w.status === 'active').length, 0));
}
