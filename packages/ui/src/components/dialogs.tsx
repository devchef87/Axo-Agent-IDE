import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUp, Folder, FolderOpen } from 'lucide-react';
import type { Agent, FsEntry } from '@axo/protocol';
import { useAxo } from '../stores/store.ts';
import { bridge } from '../lib/bridge.ts';
import { Button, Field, inputCls, Modal } from './ui.tsx';

const ROLES = ['fullstack', 'backend', 'frontend', 'devops', 'testing', 'research', 'docs'];
const MODELS = [
  { id: 'opus', label: 'Opus (latest)' },
  { id: 'sonnet', label: 'Sonnet (latest)' },
  { id: 'haiku', label: 'Haiku (latest)' },
];

export function NewAgentDialog() {
  const target = useAxo((s) => s.ui.newAgent);
  const setUi = useAxo((s) => s.setUi);
  const client = useAxo((s) => s.client);
  const select = useAxo((s) => s.select);
  const [name, setName] = useState('');
  const [role, setRole] = useState('fullstack');
  const [model, setModel] = useState('opus');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (target) { setName(''); setTask(''); setError(null); } }, [target]);
  const close = () => setUi({ newAgent: null });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await client(target.nodeKey).post<Agent>('/agents', {
        projectId: target.projectId, name: name.trim() || undefined, role, model, task: task.trim() || undefined,
      });
      close();
      select({ nodeKey: target.nodeKey, agentId: agent.id });
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
        <Field label="Model">
          <select className={inputCls} value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </Field>
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
