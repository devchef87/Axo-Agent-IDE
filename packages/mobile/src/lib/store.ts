import { create } from 'zustand';
import type { Agent, AttachmentsReq, AttachmentsRes, EventEnvelope, FeedItem, FeedPage, NodeState, Project, Team } from '@axo/protocol';
import { HttpError, NodeClient, type ConnStatus } from './client.ts';
import type { PairedNode } from './pairing.ts';
import { loadLast, loadNodes, saveLast, saveNodes, type Selection } from './storage.ts';
import { previewOf } from './feed.ts';
import { readAsStringAsync } from 'expo-file-system/legacy';
import { MAX_ATTACHMENT_BYTES, type Attachment } from './attachments.ts';

export type { Selection };

export interface NodeView {
  key: string;
  name: string;
  status: ConnStatus;
  error?: string;
  hostname?: string;
  projects: Project[];
  teams: Team[];
  agents: Agent[];
}

export interface FeedState {
  items: FeedItem[];
  drafts: Record<string, string>;   // streamed text by item id, until the final item lands
  hasMore: boolean;
  loaded: boolean;
  loadingOlder: boolean;
}

export interface Preview { text: string; ts: number; author?: string }

interface AxoState {
  ready: boolean;                    // secure storage read
  paired: PairedNode[];
  nodes: Record<string, NodeView>;
  nodeOrder: string[];
  feeds: Record<string, FeedState>;
  previews: Record<string, Preview>;
  selected: Selection | null;

  init(): Promise<void>;
  pair(nodes: PairedNode[]): Promise<void>;
  unpair(): Promise<void>;
  select(sel: Selection | null): void;
  loadFeed(nodeKey: string, agentId: string, older?: boolean): Promise<void>;
  loadPreviews(): void;
  send(sel: Selection, text: string): Promise<void>;
  upload(sel: Selection, files: Attachment[]): Promise<string[]>;
  interrupt(sel: Selection): Promise<void>;
  wake(): void;
}

export const feedKey = (nodeKey: string, agentId: string) => `${nodeKey}:${agentId}`;
const emptyFeed = (): FeedState => ({ items: [], drafts: {}, hasMore: false, loaded: false, loadingOlder: false });
const PAGE = 80;

const clients = new Map<string, NodeClient>();
const previewsLoaded = new Set<string>(); // nodeKeys whose previews were fetched since connecting

export function client(nodeKey: string): NodeClient {
  const c = clients.get(nodeKey);
  if (!c) throw new Error('That server is not paired.');
  return c;
}

export const useAxo = create<AxoState>((set, get) => {
  const patchNode = (key: string, fn: (n: NodeView) => Partial<NodeView>) =>
    set((s) => (s.nodes[key] ? { nodes: { ...s.nodes, [key]: { ...s.nodes[key], ...fn(s.nodes[key]) } } } : {}));

  const patchFeed = (fk: string, fn: (f: FeedState) => Partial<FeedState>) =>
    set((s) => {
      const f = s.feeds[fk] ?? emptyFeed();
      return { feeds: { ...s.feeds, [fk]: { ...f, ...fn(f) } } };
    });

  const setPreview = (fk: string, p: Preview | null) => {
    if (!p) return;
    const cur = get().previews[fk];
    if (cur && cur.ts > p.ts) return;
    set((s) => ({ previews: { ...s.previews, [fk]: p } }));
  };

  const upsert = <T extends { id: string }>(list: T[], item: T): T[] => {
    const i = list.findIndex((x) => x.id === item.id);
    if (i === -1) return [...list, item];
    const next = list.slice();
    next[i] = item;
    return next;
  };

  const onState = (key: string, st: NodeState) => {
    patchNode(key, () => ({ hostname: st.hostname, projects: st.projects, teams: st.teams, agents: st.agents }));
    // Node restarted or the gap was too large: reload any feed we're showing for it.
    for (const fk of Object.keys(get().feeds)) {
      if (fk.startsWith(key + ':')) void get().loadFeed(key, fk.slice(key.length + 1));
    }
    const sel = get().selected;
    if (sel?.nodeKey === key && !get().feeds[feedKey(key, sel.agentId)]?.loaded) void get().loadFeed(key, sel.agentId);
    previewsLoaded.delete(key);
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
        const sel = get().selected;
        if (sel?.nodeKey === key && sel.agentId === ev.agentId) get().select(null);
        break;
      }
      case 'agent:feed': {
        const fk = feedKey(key, ev.agentId);
        setPreview(fk, previewOf(ev.item));
        if (!get().feeds[fk]?.loaded) break; // not showing it; loads on open
        patchFeed(fk, (f) => {
          const drafts = { ...f.drafts };
          if (ev.item.kind === 'text') {
            // The final text supersedes streamed drafts for the same message.
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

  const startClients = (paired: PairedNode[]) => {
    for (const c of clients.values()) c.stop();
    clients.clear();
    previewsLoaded.clear();
    const nodes: Record<string, NodeView> = {};
    for (const p of paired) nodes[p.id] = { key: p.id, name: p.name, status: 'connecting', projects: [], teams: [], agents: [] };
    set({ nodes, nodeOrder: paired.map((p) => p.id), feeds: {}, previews: {} });
    for (const p of paired) {
      const c = new NodeClient(p, {
        onState: (st) => onState(p.id, st),
        onEvent: (ev) => onEvent(p.id, ev),
        onStatus: (status, error) => patchNode(p.id, () => ({ status, error })),
      });
      clients.set(p.id, c);
      c.start();
    }
  };

  return {
    ready: false,
    paired: [],
    nodes: {},
    nodeOrder: [],
    feeds: {},
    previews: {},
    selected: null,

    async init() {
      const [paired, last] = await Promise.all([loadNodes(), loadLast()]);
      const selected = last && paired.some((p) => p.id === last.nodeKey) ? last : null;
      set({ paired, selected, ready: true });
      startClients(paired);
    },

    async pair(nodes) {
      await saveNodes(nodes);
      const sel = get().selected;
      const keep = sel && nodes.some((n) => n.id === sel.nodeKey) ? sel : null;
      set({ paired: nodes, selected: keep });
      if (!keep) void saveLast(null);
      startClients(nodes);
    },

    async unpair() {
      await saveNodes([]);
      await saveLast(null);
      set({ paired: [], selected: null });
      startClients([]);
    },

    select(sel) {
      const prev = get().selected;
      set({ selected: sel });
      void saveLast(sel);
      // Keep only the feed on screen in memory; others reload when reopened.
      set((s) => ({ feeds: sel && s.feeds[feedKey(sel.nodeKey, sel.agentId)] ? { [feedKey(sel.nodeKey, sel.agentId)]: s.feeds[feedKey(sel.nodeKey, sel.agentId)] } : {} }));
      if (sel && (sel.nodeKey !== prev?.nodeKey || sel.agentId !== prev?.agentId || !get().feeds[feedKey(sel.nodeKey, sel.agentId)]?.loaded)) {
        void get().loadFeed(sel.nodeKey, sel.agentId);
      }
    },

    async loadFeed(nodeKey, agentId, older = false) {
      const fk = feedKey(nodeKey, agentId);
      const cur = get().feeds[fk];
      if (older && (!cur?.hasMore || cur.loadingOlder)) return;
      const c = clients.get(nodeKey);
      if (!c) return;
      if (older) patchFeed(fk, () => ({ loadingOlder: true }));
      const before = older && cur?.items.length ? `&before=${cur.items[0].ts}` : '';
      try {
        const page = await c.get<FeedPage>(`/agents/${agentId}/feed?limit=${PAGE}${before}`);
        patchFeed(fk, (f) => ({
          items: older ? [...page.items.filter((i) => !f.items.some((x) => x.id === i.id)), ...f.items] : page.items,
          hasMore: page.hasMore,
          loaded: true,
          loadingOlder: false,
          drafts: older ? f.drafts : {},
        }));
        if (!older) {
          for (let i = page.items.length - 1; i >= 0; i--) {
            const p = previewOf(page.items[i]);
            if (p) { setPreview(fk, p); break; }
          }
        }
      } catch {
        if (older) patchFeed(fk, () => ({ loadingOlder: false })); // offline or agent gone; leave as-is
      }
    },

    /** Drawer opened: fetch the last message of agents we haven't seen one for yet (once per connection). */
    loadPreviews() {
      for (const key of get().nodeOrder) {
        const n = get().nodes[key];
        if (!n || n.status !== 'online' || previewsLoaded.has(key)) continue;
        previewsLoaded.add(key);
        const c = clients.get(key);
        for (const a of n.agents) {
          const fk = feedKey(key, a.id);
          if (a.preview !== undefined || get().previews[fk]) continue; // nodes with Agent.preview send it in state
          c?.get<FeedPage>(`/agents/${a.id}/feed?limit=12`).then((page) => {
            for (let i = page.items.length - 1; i >= 0; i--) {
              const p = previewOf(page.items[i]);
              if (p) { setPreview(fk, p); break; }
            }
          }, () => {});
        }
      }
    },

    async send(sel, text) {
      await client(sel.nodeKey).post(`/agents/${sel.agentId}/message`, { text });
    },

    /** Upload attachments into the agent's .axo/uploads/; returns their absolute paths for the message. */
    async upload(sel, files) {
      const big = files.find((f) => f.size != null && f.size > MAX_ATTACHMENT_BYTES);
      if (big) throw new Error(`${big.name} is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
      const list: AttachmentsReq['files'] = await Promise.all(files.map(async (f) => ({ name: f.name, content: await readAsStringAsync(f.uri, { encoding: 'base64' }) })));
      try {
        const res = await client(sel.nodeKey).post<AttachmentsRes>(`/agents/${sel.agentId}/attachments`, { files: list } satisfies AttachmentsReq);
        return res.paths;
      } catch (e) {
        if (e instanceof HttpError && (e.status === 404 || e.status === 401)) throw new Error('This server needs an update before it can take attachments from the phone.');
        throw e;
      }
    },

    async interrupt(sel) {
      await client(sel.nodeKey).post(`/agents/${sel.agentId}/interrupt`);
    },

    wake() {
      for (const c of clients.values()) c.wake();
    },
  };
});

/** Drawer line for an agent: the node's Agent.preview, or what this phone saw last, whichever is newer. */
export function usePreview(nodeKey: string, agent: Agent): Preview | null {
  const local = useAxo((s) => s.previews[feedKey(nodeKey, agent.id)]);
  const remote = agent.preview ? { text: agent.preview.text, ts: agent.preview.ts, author: agent.preview.author ?? undefined } : null;
  if (!local) return remote;
  if (!remote) return local;
  return remote.ts >= local.ts ? remote : local;
}

/** URL for a tool-result image (device tokens may read these; <Image> can't send headers, so ?token=). */
export function imageUrl(nodeKey: string, agentId: string, imageId: string): string | null {
  const c = clients.get(nodeKey);
  if (!c) return null;
  return `${c.node.url}/api/agents/${agentId}/images/${encodeURIComponent(imageId)}?token=${encodeURIComponent(c.node.token)}`;
}

export function useAgent(sel: Selection | null): Agent | null {
  return useAxo((s) => (sel ? s.nodes[sel.nodeKey]?.agents.find((a) => a.id === sel.agentId) ?? null : null));
}
