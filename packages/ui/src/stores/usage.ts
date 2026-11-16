// Today's token/cost totals per node and per agent, from GET /usage?since=<local midnight>.
// Refetched after each finished turn (debounced), every minute, and when the day rolls over.
import { useEffect } from 'react';
import { create } from 'zustand';
import type { UsageSummary, UsageTotals } from '@axo/protocol';
import { onNodeEvent, useAxo } from './store.ts';

export const useUsage = create<{ byNode: Record<string, UsageSummary> }>(() => ({ byNode: {} }));

export const localMidnight = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
export const totalTokens = (u: UsageTotals | undefined) => (u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0);

export function useUsageSync(): void {
  const online = useAxo((s) => s.nodeOrder.filter((k) => s.nodes[k].status === 'online').join(','));
  const client = useAxo((s) => s.client);

  useEffect(() => {
    const keys = online.split(',').filter(Boolean);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const load = (k: string) => client(k).get<UsageSummary>(`/usage?since=${localMidnight()}`)
      .then((u) => useUsage.setState((s) => ({ byNode: { ...s.byNode, [k]: u } })), () => {});
    const soon = (k: string) => {
      if (timers.has(k)) return;
      timers.set(k, setTimeout(() => { timers.delete(k); void load(k); }, 1500));
    };
    useUsage.setState((s) => ({ byNode: Object.fromEntries(Object.entries(s.byNode).filter(([k]) => keys.includes(k))) }));
    for (const k of keys) void load(k);
    let day = localMidnight();
    const tick = setInterval(() => {
      if (localMidnight() !== day) day = localMidnight(); // new day: totals reset
      for (const k of keys) void load(k);
    }, 60_000);
    const off = onNodeEvent((k, ev) => {
      if (ev.type === 'agent:feed' && ev.item.kind === 'turn' && keys.includes(k)) soon(k);
    });
    return () => { off(); clearInterval(tick); for (const t of timers.values()) clearTimeout(t); };
  }, [online, client]);
}

export const useAgentToday = (nodeKey: string, agentId: string) => useUsage((s) => s.byNode[nodeKey]?.agents[agentId]);
export const useNodeToday = (nodeKey: string) => useUsage((s) => s.byNode[nodeKey]?.total);

export function formatUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`;
}
