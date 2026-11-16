import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { GitFork, Pencil, Power, RefreshCw, Trash2, X } from 'lucide-react';
import type { Agent, StateDoc } from '@axo/protocol';
import { diffAgent, formatAgo, toForm, type Form } from '../lib/agent-form.ts';
import { feedKey, focusedSel, useAgent, useAxo, useRefreshing } from '../stores/store.ts';
import { Prose } from './feed/feed.tsx';
import { Button, cn, Field, IconButton, inputCls, STATUS_LABEL, StatusDot } from './ui.tsx';
import { MODELS } from './dialogs.tsx';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
type Tab = 'state' | 'config';
const TABS: Tab[] = ['state', 'config'];

/** Right-hand panel for the agent in the focused pane. */
export function AgentDrawer() {
  const sel = useAxo(focusedSel);
  const agent = useAgent(sel);
  const refreshing = useRefreshing(sel);
  const setUi = useAxo((s) => s.setUi);
  const [tab, setTab] = useState<Tab>('state');
  const close = () => setUi({ drawer: false });

  return (
    <aside
      aria-label="Agent settings"
      className="flex h-full w-80 shrink-0 flex-col border-l border-border-subtle bg-panel"
      onKeyDown={(e) => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.stopPropagation(); close(); } }}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        {agent && <StatusDot status={agent.status} />}
        <span className="truncate text-[13px] font-semibold text-primary">{agent?.name ?? 'No agent'}</span>
        {agent && (refreshing ? <span className="text-2xs text-rotating">refreshing…</span> : <span className="text-2xs text-faint">{STATUS_LABEL[agent.status]}</span>)}
        <IconButton title="Close (Esc)" className="ml-auto" onClick={close}><X size={14} /></IconButton>
      </div>
      <div role="tablist" className="flex shrink-0 gap-1 border-b border-border-subtle px-3">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn('-mb-px border-b-2 px-1.5 py-2 text-xs font-medium capitalize cursor-pointer',
              tab === t ? 'border-accent text-primary' : 'border-transparent text-muted hover:text-secondary')}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!agent || !sel ? (
          <p className="p-4 text-xs text-faint">Focus a pane with an agent to see its settings.</p>
        ) : (
          tab === 'state'
            ? <StateTab key={`${sel.nodeKey}:${agent.id}`} nodeKey={sel.nodeKey} agent={agent} />
            : <ConfigTab key={`${sel.nodeKey}:${agent.id}`} nodeKey={sel.nodeKey} agent={agent} />
        )}
      </div>
    </aside>
  );
}

function ConfigTab({ nodeKey, agent }: { nodeKey: string; agent: Agent }) {
  const client = useAxo((s) => s.client);
  const [form, setForm] = useState<Form>(() => toForm(agent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changes = useMemo(() => diffAgent(agent, form), [agent, form]);
  const dirty = Object.keys(changes).length > 0;
  const live = agent.status !== 'asleep' && agent.status !== 'stopped';

  // Pick up changes made elsewhere while the form is untouched.
  const base = JSON.stringify(toForm(agent));
  const [lastBase, setLastBase] = useState(base);
  useEffect(() => {
    if (base === lastBase) return;
    if (!dirty) setForm(toForm(agent));
    setLastBase(base);
  }, [base]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<Form>) => { setForm((f) => ({ ...f, ...patch })); setSaved(false); };

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!dirty) return;
    setBusy(true);
    setError(null);
    try {
      await client(nodeKey).patch(`/agents/${agent.id}`, changes);
      setSaved(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const setUi = useAxo((s) => s.setUi);
  const refreshing = useRefreshing({ nodeKey, agentId: agent.id });
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); } catch (err: any) { setError(err.message); } };

  const models = MODELS.some((m) => m.id === agent.model) ? MODELS : [...MODELS, { id: agent.model, label: agent.model }];

  return (
    <form className="p-4" onSubmit={save} onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) void save(); }}>
      <Field label="Name">
        <input className={inputCls} value={form.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Model">
          <select className={inputCls} value={form.model} onChange={(e) => set({ model: e.target.value })}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="Effort">
          <select className={inputCls} value={form.effort} onChange={(e) => set({ effort: e.target.value })}>
            <option value="">Default</option>
            {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Standing instructions" hint="Added to the system prompt.">
        <textarea
          className={inputCls + ' min-h-28 resize-y'}
          value={form.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          placeholder="e.g. Always run the tests before saying you are done."
        />
      </Field>
      <Field label="Scope" hint="Paths this agent may edit, one glob per line. Empty = whole project.">
        <textarea
          className={inputCls + ' min-h-20 resize-y font-mono text-xs'}
          value={form.scope}
          onChange={(e) => set({ scope: e.target.value })}
          placeholder={'packages/ui/**\ndocs/**'}
          spellCheck={false}
        />
      </Field>
      <p className="mb-3 text-2xs text-faint">
        Model, effort and instructions take effect on the next turn. If the agent is working, they apply once the current turn ends.
      </p>
      {error && <p role="alert" className="mb-3 text-xs text-danger">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        {saved && !dirty && <span className="mr-auto text-xs text-success">Saved</span>}
        <Button type="button" variant="ghost" disabled={!dirty || busy} onClick={() => { setForm(toForm(agent)); setError(null); }}>Revert</Button>
        <Button type="submit" variant="primary" disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>

      <div className="mt-6 border-t border-border-subtle pt-4">
        <h3 className="mb-2 text-xs font-medium text-muted">Actions</h3>
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" disabled={refreshing} title="Fresh context, same agent, chat and working state" onClick={() => setUi({ refresh: { nodeKey, agentId: agent.id } })}>
              <RefreshCw size={13} className={cn(refreshing && 'animate-spin [animation-duration:2s]')} /> {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
            <Button type="button" title="New agent seeded with this agent's working state" onClick={() => setUi({ fork: { nodeKey, agentId: agent.id } })}>
              <GitFork size={13} /> Fork
            </Button>
          </div>
          <Button
            type="button"
            disabled={!live}
            title={live ? 'End the process; the agent keeps its session and resumes on the next message' : 'No process running'}
            onClick={() => void act(() => client(nodeKey).post(`/agents/${agent.id}/stop`))}
          >
            <Power size={13} /> Stop process
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              if (confirm(`Delete agent ${agent.name}? Its chat history will be removed.`)) void act(() => client(nodeKey).del(`/agents/${agent.id}`));
            }}
          >
            <Trash2 size={13} /> Delete agent
          </Button>
        </div>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-2xs">
          <dt className="text-faint">Role</dt><dd className="truncate text-secondary">{agent.role}</dd>
          <dt className="text-faint">Workdir</dt><dd className="truncate font-mono text-secondary" title={agent.workdir}>{agent.workdir}</dd>
          <dt className="text-faint">Session</dt><dd className="truncate font-mono text-secondary">{agent.sessionId ?? '—'}</dd>
          <dt className="text-faint">Generation</dt><dd className="text-secondary">{agent.generation}</dd>
        </dl>
      </div>
    </form>
  );
}

/** The journalist's live working-state doc. Editable; edits apply on the agent's next turn. */
function StateTab({ nodeKey, agent }: { nodeKey: string; agent: Agent }) {
  const client = useAxo((s) => s.client);
  const rev = useAxo((s) => s.journalRev[feedKey(nodeKey, agent.id)] ?? 0);
  const [doc, setDoc] = useState<StateDoc | null>(null);
  const [draft, setDraft] = useState<string | null>(null); // non-null = editing
  const [incoming, setIncoming] = useState<StateDoc | null>(null); // arrived while editing
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  editing.current = draft !== null;

  const load = useCallback(async () => {
    try {
      const d = await client(nodeKey).get<StateDoc>(`/agents/${agent.id}/state`);
      setError(null);
      return d;
    } catch (e: any) {
      setError(e.message);
      return null;
    }
  }, [client, nodeKey, agent.id]);

  useEffect(() => {
    let live = true;
    void load().then((d) => {
      if (!live || !d) return;
      // Don't yank the text out from under someone who is editing.
      if (editing.current) setIncoming(d);
      else setDoc(d);
    });
    return () => { live = false; };
  }, [load, rev]);

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    try {
      await client(nodeKey).post(`/agents/${agent.id}/state`, { text: draft });
      const d = await load();
      if (d) setDoc(d);
      setDraft(null);
      setIncoming(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (draft !== null) {
    return (
      <div className="flex h-full flex-col p-3" onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); void save(); } }}>
        {incoming && (
          <div className="mb-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-2xs text-warning">
            The journalist updated this while you were editing. Saving replaces its version.{' '}
            <button className="underline cursor-pointer" onClick={() => { setDraft(incoming.text); setDoc(incoming); setIncoming(null); }}>Load theirs</button>
          </div>
        )}
        <textarea
          autoFocus
          aria-label="Working state (markdown)"
          className={inputCls + ' min-h-0 flex-1 resize-none font-mono text-xs leading-relaxed'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />
        <p className="mt-2 text-2xs text-faint">Markdown. Your edits apply on the agent's next turn. ⌘Enter to save.</p>
        {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => { setDraft(null); if (incoming) { setDoc(incoming); setIncoming(null); } }}>Cancel</Button>
          <Button type="button" variant="primary" disabled={busy || draft === doc?.text} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2 text-2xs text-faint">
        <span>{doc?.updatedAt ? `Updated ${formatAgo(doc.updatedAt)}` : doc ? 'Not written yet' : 'Loading…'}</span>
        <Button size="sm" variant="ghost" className="ml-auto" disabled={!doc} onClick={() => setDraft(doc?.text ?? '')}>
          <Pencil size={11} /> Edit
        </Button>
      </div>
      {error && <p role="alert" className="mb-3 text-xs text-danger">{error}</p>}
      {doc && (doc.text.trim()
        ? <div className="text-[13px]"><Prose text={doc.text} /></div>
        : <p className="text-xs leading-relaxed text-faint">No working state yet. The journalist writes it after meaningful turns, and you can start it yourself with Edit.</p>)}
    </div>
  );
}
