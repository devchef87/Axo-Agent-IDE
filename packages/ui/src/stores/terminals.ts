// Terminal panel: tabs of PTY sessions on any node. Sessions live on the node, so hiding the panel,
// reloading or a dropped tunnel never kills a shell; on (re)connect we list the node's sessions and
// re-adopt them. Only tab order, the active tab, open state and height are kept locally.
import { create } from 'zustand';
import type { TerminalInfo } from '@axo/protocol';
import { focusedSel, tryClient, useAxo } from './store.ts';
import { useEditor } from './editor.ts';
import { nextActive, reconcile, tabFromInfo, type TermTab } from '../lib/terminal-model.ts';

const KEY = 'axo.terminals';
export const MIN_HEIGHT = 120;

interface Persisted { open: boolean; height: number; active: string | null; order: string[] }

function load(): Persisted {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return {
      open: !!v?.open,
      height: Number.isFinite(v?.height) ? Math.max(MIN_HEIGHT, v.height) : 280,
      active: typeof v?.active === 'string' ? v.active : null,
      order: Array.isArray(v?.order) ? v.order.filter((k: unknown) => typeof k === 'string') : [],
    };
  } catch { return { open: false, height: 280, active: null, order: [] }; }
}

/** Where "new terminal" opens by default: the folder you're looking at. */
export interface TermPlace { nodeKey: string; cwd?: string; label: string }

export function contextPlace(): TermPlace | null {
  const s = useAxo.getState();
  if (s.view === 'editor') {
    const t = useEditor.getState().target;
    const node = t ? s.nodes[t.nodeKey] : undefined;
    const project = node?.projects.find((p) => p.id === t!.projectId);
    if (node && project && node.status === 'online') {
      const agent = t!.agent ? node.agents.find((a) => a.id === t!.agent) : undefined;
      const team = t!.team ? node.teams.find((x) => x.id === t!.team) : undefined;
      const cwd = agent?.workdir ?? team?.worktreePath ?? project.path;
      return { nodeKey: node.key, cwd, label: `${node.name} · ${agent?.name ?? team?.name ?? project.name}` };
    }
  }
  const sel = focusedSel(s);
  const node = sel ? s.nodes[sel.nodeKey] : undefined;
  const agent = node?.agents.find((a) => a.id === sel!.agentId);
  if (node && agent && node.status === 'online') return { nodeKey: node.key, cwd: agent.workdir, label: `${node.name} · ${agent.name}` };
  const first = s.nodeOrder.find((k) => s.nodes[k].status === 'online');
  return first ? { nodeKey: first, label: `${s.nodes[first].name} · ~` } : null;
}

interface TerminalsState extends Persisted {
  tabs: TermTab[];
  error: string | null;
  /** Bumped to ask the active terminal to take keyboard focus. */
  focusRev: number;
  setOpen(open: boolean): void;
  toggle(): void;
  setHeight(h: number): void;
  select(key: string): void;
  create(place?: TermPlace | null): Promise<void>;
  close(key: string): Promise<void>;
  markExited(key: string, code: number): void;
  /** Drop a tab whose session the node no longer has (e.g. the node restarted). */
  forget(key: string): void;
  sync(nodeKey: string, list: TerminalInfo[]): void;
}

export const useTerminals = create<TerminalsState>((set, get) => {
  const save = () => {
    const { open, height, active, tabs, order } = get();
    // Keep remembered keys of nodes that haven't reconnected yet, so their tabs come back in place.
    const live = tabs.map((t) => t.key);
    const merged = [...live, ...order.filter((k) => !live.includes(k))];
    localStorage.setItem(KEY, JSON.stringify({ open, height, active, order: merged.slice(0, 50) }));
  };
  const update = (patch: Partial<TerminalsState>) => { set(patch); save(); };

  return {
    ...load(),
    tabs: [],
    error: null,
    focusRev: 0,

    setOpen(open) {
      update({ open, focusRev: open ? get().focusRev + 1 : get().focusRev });
      if (open && !get().tabs.length) void get().create();
    },
    toggle() { get().setOpen(!get().open); },
    setHeight(h) { update({ height: Math.max(MIN_HEIGHT, Math.round(h)) }); },
    select(key) { update({ active: key, open: true, focusRev: get().focusRev + 1 }); },

    async create(place = contextPlace()) {
      if (!place) { set({ error: 'No server is connected.', open: true }); return; }
      const c = tryClient(place.nodeKey);
      if (!c) { set({ error: `${place.label} isn't connected.`, open: true }); return; }
      try {
        const info = await c.post<TerminalInfo>('/terminals', place.cwd ? { cwd: place.cwd } : {});
        const tab = tabFromInfo(place.nodeKey, info);
        update({ tabs: [...get().tabs.filter((t) => t.key !== tab.key), tab], active: tab.key, open: true, error: null, focusRev: get().focusRev + 1 });
      } catch (e: any) {
        set({ error: /not found/i.test(e?.message ?? '') ? `${place.label.split(' · ')[0]} runs an older Axo without terminals. Update it from Servers.` : e?.message ?? String(e), open: true });
      }
    },

    async close(key) {
      const tab = get().tabs.find((t) => t.key === key);
      if (!tab) return;
      get().forget(key);
      if (!tab.exited) await tryClient(tab.nodeKey)?.del(`/terminals/${tab.id}`).catch(() => {});
    },

    forget(key) {
      const { tabs, active } = get();
      update({ tabs: tabs.filter((t) => t.key !== key), active: active === key ? nextActive(tabs, key) : active, order: get().order.filter((k) => k !== key) });
    },

    markExited(key, code) {
      set({ tabs: get().tabs.map((t) => (t.key === key ? { ...t, exited: true, exitCode: code } : t)) });
    },

    sync(nodeKey, list) {
      const { tabs, order, active } = get();
      const next = reconcile(tabs, nodeKey, list, order);
      update({ tabs: next, active: active && next.some((t) => t.key === active) ? active : next[0]?.key ?? null });
    },
  };
});

/** Fetch each node's sessions when it comes online, so shells opened before a reload come back. */
export function startTerminalSync(): () => void {
  const seen = new Map<string, string>();
  const check = () => {
    const { nodes } = useAxo.getState();
    for (const [k, n] of Object.entries(nodes)) {
      const was = seen.get(k);
      seen.set(k, n.status);
      if (n.status !== 'online' || was === 'online') continue;
      tryClient(k)?.get<TerminalInfo[]>('/terminals')
        .then((list) => useTerminals.getState().sync(k, list))
        .catch(() => { /* older node without terminals */ });
    }
  };
  check();
  return useAxo.subscribe(check);
}
