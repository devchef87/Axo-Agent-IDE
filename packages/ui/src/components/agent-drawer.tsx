import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Power, Trash2, X } from 'lucide-react';
import type { Agent, UpdateAgentReq } from '@axo/protocol';
import { focusedSel, useAgent, useAxo } from '../stores/store.ts';
import { Button, cn, Field, IconButton, inputCls, STATUS_LABEL, StatusDot } from './ui.tsx';
import { MODELS } from './dialogs.tsx';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
type Tab = 'config';

/** Right-hand panel for the agent in the focused pane. */
export function AgentDrawer() {
  const sel = useAxo(focusedSel);
  const agent = useAgent(sel);
  const setUi = useAxo((s) => s.setUi);
  const [tab, setTab] = useState<Tab>('config');
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
        {agent && <span className="text-2xs text-faint">{STATUS_LABEL[agent.status]}</span>}
        <IconButton title="Close (Esc)" className="ml-auto" onClick={close}><X size={14} /></IconButton>
      </div>
      <div role="tablist" className="flex shrink-0 gap-1 border-b border-border-subtle px-3">
        {(['config'] as Tab[]).map((t) => (
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
          <ConfigTab key={`${sel.nodeKey}:${agent.id}`} nodeKey={sel.nodeKey} agent={agent} />
        )}
      </div>
    </aside>
  );
}

interface Form { name: string; model: string; effort: string; instructions: string; scope: string }

const toForm = (a: Agent): Form => ({
  name: a.name, model: a.model, effort: a.effort ?? '', instructions: a.instructions, scope: a.scopeGlobs.join('\n'),
});

/** Only the fields that changed, in the PATCH /agents/:id shape. */
export function diffAgent(a: Agent, f: Form): UpdateAgentReq {
  const out: UpdateAgentReq = {};
  const name = f.name.trim();
  if (name !== a.name) out.name = name;
  if (f.model !== a.model) out.model = f.model;
  if ((f.effort || null) !== a.effort) out.effort = f.effort || null;
  if (f.instructions !== a.instructions) out.instructions = f.instructions;
  const scope = f.scope.split('\n').map((s) => s.trim()).filter(Boolean);
  if (scope.join('\n') !== a.scopeGlobs.join('\n')) out.scopeGlobs = scope;
  return out;
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
        Model, effort and instructions apply when the process next starts. An idle agent picks them up on its next message; for a working one, stop the process once this turn ends.
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
