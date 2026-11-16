import { create } from 'zustand';
import type { ServersSnapshot } from '@axo/protocol';
import { bridge } from '../../lib/bridge.ts';

/** Server registry + live status, pushed by the main process. Electron only. */
interface ServersState {
  snap: ServersSnapshot | null;
  /** Per-server action in flight from this window (button spinners). */
  pending: Record<string, string>;
  start(): void;
  run(id: string, label: string, fn: () => Promise<unknown>): Promise<string | null>;
}

let started = false;

export const useServers = create<ServersState>((set) => ({
  snap: null,
  pending: {},
  start() {
    const api = bridge?.servers;
    if (started || !api) return;
    started = true;
    api.onChanged((snap) => set({ snap }));
    void api.snapshot().then((snap) => set({ snap }));
  },
  /** Runs an action; returns an error message or null. */
  async run(id, label, fn) {
    set((s) => ({ pending: { ...s.pending, [id]: label } }));
    try {
      await fn();
      return null;
    } catch (e: any) {
      // Electron prefixes IPC errors with "Error invoking remote method '…': Error: "
      return String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    } finally {
      set((s) => { const pending = { ...s.pending }; delete pending[id]; return { pending }; });
    }
  },
}));

export const serversApi = () => bridge?.servers ?? null;
