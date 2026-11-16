import { create } from 'zustand';
import type { Agent, EventEnvelope, FeedItem, FeedPage, NodeState, Project, Team } from '@axo/protocol';
import { NodeClient, type ConnStatus } from '../lib/client.ts';
import { discoverNodes, type NodeConn } from '../lib/bridge.ts';
import * as L from '../lib/layout.ts';
import type { Layout, Selection } from '../lib/layout.ts';

export type { Selection } from '../lib/layout.ts';

export interface NodeView {
  key: string;
  name: string;
  status: ConnStatus;
  error?: string;
  hostname?: string;
  version?: string;
  projects: Project[];
  teams: Team[];
  agents: Agent[];
}

export interface FeedState {
  items: FeedItem[];
  hasMore: boolean;
  loaded: boolean;
  drafts: Record<string, string>; // streaming text by item id
}

interface AxoState {
  nodes: Record<string, NodeView>;
  nodeOrder: string[];
  feeds: Record<string, FeedState>;  // key: `${nodeKey}:${agentId}`
  layout: Layout;
  ui: {
    newAgent: { nodeKey: string; projectId: string } | null;
    addProject: string | null;
    palette: boolean;
    drawer: boolean; // agent config drawer for the focused pane
  };

  init(): Promise<void>;
  client(nodeKey: string): NodeClient;
  /** Show an agent in the focused pane (or focus the pane already showing it). */
  select(sel: Selection): void;
  openInSplit(sel: Selection): void;
  openInPane(sel: Selection, index: number): void;
  focusPane(index: number): void;
  closePane(index: number): void;
  resizePanes(divider: number, delta: number): void;
  resetPaneSizes(): void;
  loadFeed(nodeKey: string, agentId: string, older?: boolean): Promise<void>;
  setUi(patch: Partial<AxoState['ui']>): void;
}

export const feedKey = (nodeKey: string, agentId: string) => `${nodeKey}:${agentId}`;
const emptyFeed = (): FeedState => ({ items: [], hasMore: false, loaded: false, drafts: {} });

const clients = new Map<string, NodeClient>();
const LAYOUT_KEY = 'axo.layout';

function loadLayout(): Layout {
  const raw = localStorage.getItem(LAYOUT_KEY);
  if (raw) return L.parseLayout(raw);
  // Phase 1 stored a single selection.
  const old = L.parseLayout(JSON.stringify({ panes: [JSON.parse(localStorage.getItem('axo.selected') ?? 'null')] }));
  localStorage.removeItem('axo.selected');
  return old;
}

/** The agent in the focused pane, if any. */
export const focusedSel = (s: { layout: Layout }): Selection | null => s.layout.panes[s.layout.focused] ?? null;

export const useAxo = create<AxoState>((set, get) => {
  const patchNode = (key: string, fn: (n: NodeView) => Partial<NodeView>) =>
    set((s) => (s.nodes[key] ? { nodes: { ...s.nodes, [key]: { ...s.nodes[key], ...fn(s.nodes[key]) } } } : {}));

  const patchFeed = (key: string, fn: (f: FeedState) => Partial<FeedState>) =>
    set((s) => {
      const f = s.feeds[key] ?? emptyFeed();
      return { feeds: { ...s.feeds, [key]: { ...f, ...fn(f) } } };
    });

  const upsert = <T extends { id: string }>(list: T[], item: T): T[] => {
    const i = list.findIndex((x) => x.id === item.id);
    if (i === -1) return [...list, item];
    const next = list.slice();
    next[i] = item;
    return next;
  };

  const onState = (key: string, st: NodeState) => {
    patchNode(key, () => ({ hostname: st.hostname, version: st.version, projects: st.projects, teams: st.teams, agents: st.agents }));
    // Node restarted or gap too large: refetch any feeds we had loaded.
    for (const fk of Object.keys(get().feeds)) {
      if (fk.startsWith(key + ':')) void get().loadFeed(key, fk.slice(key.length + 1));
    }
  };

  const onEvent = (key: string, ev: EventEnvelope) => {
    switch (ev.type) {
      case 'project:upsert': patchNode(key, (n) => ({ projects: upsert(n.projects, ev.project) })); break;
      case 'project:removed': patchNode(key, (n) => ({
        projects: n.projects.filter((p) => p.id !== ev.projectId),
        teams: n.teams.filter((t) => t.projectId !== ev.projectId),
        agents: n.agents.filter((a) => a.projectId !== ev.projectId),
      })); break;
      case 'team:upsert': patchNode(key, (n) => ({ teams: upsert(n.teams, ev.team) })); break;
      case 'team:removed': patchNode(key, (n) => ({ teams: n.teams.filter((t) => t.id !== ev.teamId) })); break;
      case 'agent:upsert': patchNode(key, (n) => ({ agents: upsert(n.agents, ev.agent) })); break;
      case 'agent:removed': {
        patchNode(key, (n) => ({ agents: n.agents.filter((a) => a.id !== ev.agentId) }));
        setLayout(L.dropAgent(get().layout, { nodeKey: key, agentId: ev.agentId }));
        break;
      }
      case 'agent:feed': {
        const fk = feedKey(key, ev.agentId);
        if (!get().feeds[fk]?.loaded) break; // not viewing; will load on open
        patchFeed(fk, (f) => {
          const drafts = { ...f.drafts };
          if (ev.item.kind === 'text') {
            // Final text supersedes streamed drafts for the same message.
            const msg = ev.item.id.replace(/-\d+$/, '');
            for (const d of Object.keys(drafts)) if (d.startsWith(msg)) delete drafts[d];
          }
          if (ev.item.kind === 'turn') for (const d of Object.keys(drafts)) delete drafts[d];
          return { items: upsert(f.items, ev.item), drafts };
        });
        break;
      }
      case 'agent:text-delta': {
        const fk = feedKey(key, ev.agentId);
        if (!get().feeds[fk]?.loaded) break;
        patchFeed(fk, (f) => {
          if (f.items.some((i) => i.id === ev.itemId)) return {};
          return { drafts: { ...f.drafts, [ev.itemId]: (f.drafts[ev.itemId] ?? '') + ev.text } };
        });
        break;
      }
      default: break;
    }
  };

  const setLayout = (layout: Layout) => {
    if (layout === get().layout) return;
    set({ layout });
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    for (const p of layout.panes) {
      if (p && !get().feeds[feedKey(p.nodeKey, p.agentId)]?.loaded && clients.has(p.nodeKey)) void get().loadFeed(p.nodeKey, p.agentId);
    }
  };

  const addNode = (conn: NodeConn) => {
    if (clients.has(conn.key)) return;
    set((s) => ({
      nodes: { ...s.nodes, [conn.key]: { key: conn.key, name: conn.name, status: 'connecting', projects: [], teams: [], agents: [] } },
      nodeOrder: [...s.nodeOrder, conn.key],
    }));
    const c = new NodeClient(conn, {
      onState: (st) => onState(conn.key, st),
      onEvent: (ev) => onEvent(conn.key, ev),
      onStatus: (status, error) => patchNode(conn.key, () => ({ status, error })),
    });
    clients.set(conn.key, c);
    c.start();
  };

  return {
    nodes: {},
    nodeOrder: [],
    feeds: {},
    layout: loadLayout(),
    ui: { newAgent: null, addProject: null, palette: false, drawer: false },

    async init() {
      for (const conn of await discoverNodes()) addNode(conn);
      for (const p of get().layout.panes) if (p && clients.has(p.nodeKey)) void get().loadFeed(p.nodeKey, p.agentId);
    },

    client(nodeKey) {
      const c = clients.get(nodeKey);
      if (!c) throw new Error(`unknown node ${nodeKey}`);
      return c;
    },

    select(sel) { setLayout(L.openIn(get().layout, sel)); },
    openInSplit(sel) { setLayout(L.openInSplit(get().layout, sel)); },
    openInPane(sel, index) { setLayout(L.openIn(get().layout, sel, index)); },
    focusPane(index) {
      const l = get().layout;
      if (index >= 0 && index < l.panes.length && index !== l.focused) setLayout({ ...l, focused: index });
    },
    closePane(index) { setLayout(L.closePane(get().layout, index)); },
    resizePanes(divider, delta) { setLayout(L.resize(get().layout, divider, delta)); },
    resetPaneSizes() { setLayout(L.resetSizes(get().layout)); },

    async loadFeed(nodeKey, agentId, older = false) {
      const fk = feedKey(nodeKey, agentId);
      const cur = get().feeds[fk];
      const before = older && cur?.items.length ? `&before=${cur.items[0].ts}` : '';
      try {
        const page = await get().client(nodeKey).get<FeedPage>(`/agents/${agentId}/feed?limit=200${before}`);
        patchFeed(fk, (f) => ({
          items: older ? [...page.items, ...f.items] : page.items,
          hasMore: page.hasMore,
          loaded: true,
          drafts: older ? f.drafts : {},
        }));
      } catch {
        /* node offline or agent gone; leave as-is */
      }
    },

    setUi(patch) { set((s) => ({ ui: { ...s.ui, ...patch } })); },
  };
});

export function useAgent(sel: Selection | null): Agent | null {
  return useAxo((s) => (sel ? s.nodes[sel.nodeKey]?.agents.find((a) => a.id === sel.agentId) ?? null : null));
}
