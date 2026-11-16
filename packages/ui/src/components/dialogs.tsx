import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUp, Folder, FolderOpen } from 'lucide-react';
import type { Agent, ForkReq, FsEntry, RefreshReq } from '@axo/protocol';
import { useAgent, useAxo } from '../stores/store.ts';
import { bridge } from '../lib/bridge.ts';
import { Button, Field, inputCls, Modal } from './ui.tsx';

const ROLES = ['fullstack', 'backend', 'frontend', 'devops', 'testing', 'research', 'docs'];
export const MODELS = [
  { id: 'opus', label: 'Opus (latest)' },
  { id: 'sonnet', label: 'Sonnet (latest)' },
  { id: 'haiku', label: 'Haiku (latest)' },
];

export function NewAgentDialog() {
  const target = useAxo((s) => s.ui.newAgent);
  const setUi = useAxo((s) => s.setUi);
  const client = useAxo((s) => s.client);
  const select = useAxo((s) => s.select);
  const nodes = useAxo((s) => s.nodes);
  const nodeOrder = useAxo((s) => s.nodeOrder);
  const [dest, setDest] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('fullstack');
  const [model, setModel] = useState('opus');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (target) { setName(''); setTask(''); setError(null); setDest(`${target.nodeKey}|${target.projectId}`); } }, [target]);
  const close = () => setUi({ newAgent: null });
  const projects = nodeOrder.flatMap((k) => nodes[k].projects.map((p) => ({ value: `${k}|${p.id}`, label: nodeOrder.length > 1 ? `${nodes[k].name} / ${p.name}` : p.name })));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const [nodeKey, projectId] = dest.split('|');
    if (!target || !nodeKey || !projectId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await client(nodeKey).post<Agent>('/agents', {
        projectId, name: name.trim() || undefined, role, model, task: task.trim() || undefined,
      });
      close();
      select({ nodeKey, agentId: agent.id });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!target} onClose={close} title="New agent" width={480}>
      <form onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" hint="Optional — defaults to role-N">
            <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={`${role}-1`} />
          </Field>
          <Field label="Role">
            <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => <option key={r}>{r}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Project">
            <select className={inputCls} value={dest} onChange={(e) => setDest(e.target.value)}>
              {projects.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Model">
            <select className={inputCls} value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Task" hint="Optional — sent as the first message. ⌘Enter to create.">
          <textarea
            className={inputCls + ' min-h-24 resize-y'}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) void submit(e as any); }}
            placeholder="What should this agent work on?"
          />
        </Field>
        {error && <p className="mb-3 text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Creating…' : 'Create agent'}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function AddProjectDialog() {
  const nodeKey = useAxo((s) => s.ui.addProject);
  const setUi = useAxo((s) => s.setUi);
  const client = useAxo((s) => s.client);
  const nodeName = useAxo((s) => (nodeKey ? s.nodes[nodeKey]?.name : ''));
  const [path, setPath] = useState('');
  const [browse, setBrowse] = useState<{ path: string; parent: string | null; entries: FsEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isLocal = nodeKey === 'local';

  const list = async (p?: string) => {
    if (!nodeKey) return;
    try {
      const r = await client(nodeKey).get(`/fs/list${p ? `?path=${encodeURIComponent(p)}` : ''}`);
      setBrowse(r);
      setPath(r.path);
      setError(null);
    } catch (e: any) { setError(e.message); }
  };

  useEffect(() => {
    if (!nodeKey) return;
    setPath(''); setError(null); setBrowse(null);
    if (!isLocal || !bridge) void list();
  }, [nodeKey]);

  const close = () => setUi({ addProject: null });
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!nodeKey || !path.trim()) return;
    setBusy(true);
    try {
      await client(nodeKey).post('/projects', { path: path.trim() });
      close();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const pickNative = async () => {
    const p = await bridge?.pickFolder();
    if (p) setPath(p);
  };

  return (
    <Modal open={!!nodeKey} onClose={close} title={`Add project on ${nodeName}`} width={520}>
      <form onSubmit={submit}>
        <Field label="Folder">
          <div className="flex gap-2">
            <input autoFocus className={inputCls + ' font-mono text-xs'} value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/projects/my-app" />
            {isLocal && bridge && <Button type="button" onClick={pickNative}><FolderOpen size={13} /> Choose…</Button>}
            {!(isLocal && bridge) && <Button type="button" onClick={() => void list(path || undefined)}>Browse</Button>}
          </div>
        </Field>
        {browse && (
          <div className="mb-3 max-h-64 overflow-y-auto rounded-md border border-border-subtle bg-panel py-1">
            {browse.parent && (
              <button type="button" onClick={() => void list(browse.parent!)} className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-muted hover:bg-hover cursor-pointer">
                <ArrowUp size={12} /> ..
              </button>
            )}
            {browse.entries.map((d) => (
              <button type="button" key={d.path} onClick={() => void list(d.path)} className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-secondary hover:bg-hover cursor-pointer">
                <Folder size={12} className="text-faint" /> {d.name}
              </button>
            ))}
            {browse.entries.length === 0 && <p className="px-3 py-1 text-xs text-faint">No subfolders</p>}
          </div>
        )}
        {error && <p className="mb-3 text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !path.trim()}>Add project</Button>
        </div>
      </form>
    </Modal>
  );
}

export function RefreshDialog() {
  const target = useAxo((s) => s.ui.refresh);
  const setUi = useAxo((s) => s.setUi);
  const client = useAxo((s) => s.client);
  const agent = useAgent(target);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (target) { setNote(''); setError(null); } }, [target]);
  const close = () => setUi({ refresh: null });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: RefreshReq = note.trim() ? { note: note.trim() } : {};
      await client(target.nodeKey).post(`/agents/${target.agentId}/refresh`, body);
      close();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!target} onClose={close} title={`Refresh ${agent?.name ?? 'agent'}`} width={460}>
      <form onSubmit={submit}>
        <p className="mb-3 text-xs leading-relaxed text-muted">
          Starts a fresh context for the same agent. It keeps its name, chat and working state, and carries on where it left off.
        </p>
        <Field label="What went wrong?" hint="Optional. Passed to the fresh context so it avoids the same problem. ⌘Enter to refresh.">
          <textarea
            autoFocus
            className={inputCls + ' min-h-20 resize-y'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) void submit(e as any); }}
            placeholder="e.g. It kept re-reading the same files and lost track of the failing test."
          />
        </Field>
        {error && <p role="alert" className="mb-3 text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Starting…' : 'Refresh'}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function ForkDialog() {
  const target = useAxo((s) => s.ui.fork);
  const setUi = useAxo((s) => s.setUi);
  const client = useAxo((s) => s.client);
  const select = useAxo((s) => s.select);
  const agent = useAgent(target);
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (target) { setName(''); setTask(''); setError(null); } }, [target]);
  const close = () => setUi({ fork: null });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: ForkReq = { name: name.trim() || undefined, task: task.trim() || undefined };
      const created = await client(target.nodeKey).post<Agent>(`/agents/${target.agentId}/fork`, body);
      close();
      select({ nodeKey: target.nodeKey, agentId: created.id });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!target} onClose={close} title={`Fork ${agent?.name ?? 'agent'}`} width={480}>
      <form onSubmit={submit}>
        <p className="mb-3 text-xs leading-relaxed text-muted">
          Creates a new agent in the same team with the same role and model, seeded with {agent?.name ?? 'this agent'}'s working state. The original keeps going.
        </p>
        <Field label="Name" hint="Optional — defaults to role-N">
          <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={agent ? `${agent.role}-2` : ''} />
        </Field>
        <Field label="Task" hint="Optional — otherwise it continues the work in its state. ⌘Enter to fork.">
          <textarea
            className={inputCls + ' min-h-20 resize-y'}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) void submit(e as any); }}
            placeholder="e.g. Take the UI half of this; leave the API to the original."
          />
        </Field>
        {error && <p role="alert" className="mb-3 text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Forking…' : 'Fork agent'}</Button>
        </div>
      </form>
    </Modal>
  );
}
