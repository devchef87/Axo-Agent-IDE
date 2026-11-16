import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUp, Folder, FolderOpen } from 'lucide-react';
import type { Agent, CreateTeamReq, ForkReq, FsEntry, RefreshReq, Team, TeamMode } from '@axo/protocol';
import { useAgent, useAxo } from '../stores/store.ts';
import { bridge } from '../lib/bridge.ts';
import { Button, cn, Field, inputCls, Modal } from './ui.tsx';

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
  const [teamId, setTeamId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('fullstack');
  const [model, setModel] = useState('opus');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (target) { setName(''); setTask(''); setError(null); setDest(`${target.nodeKey}|${target.projectId}`); setTeamId(target.teamId ?? ''); } }, [target]);
  const close = () => setUi({ newAgent: null });
  const [destNode, destProject] = dest.split('|');
  const teams = (nodes[destNode]?.teams ?? []).filter((t) => t.projectId === destProject && !t.archivedAt).sort((a, b) => a.createdAt - b.createdAt);
  const projects = nodeOrder.flatMap((k) => nodes[k].projects.map((p) => ({ value: `${k}|${p.id}`, label: nodeOrder.length > 1 ? `${nodes[k].name} / ${p.name}` : p.name })));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const [nodeKey, projectId] = dest.split('|');
    if (!target || !nodeKey || !projectId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await client(nodeKey).post<Agent>('/agents', {
        projectId, teamId: teams.some((t) => t.id === teamId) ? teamId : undefined, name: name.trim() || undefined, role, model, task: task.trim() || undefined,
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
            <select className={inputCls} value={dest} onChange={(e) => { setDest(e.target.value); setTeamId(''); }}>
              {projects.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Team">
            <select className={inputCls} value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={teams.length === 0}>
              <option value="">{teams.length ? 'Default team' : 'No teams yet'}</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
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

const TEAM_MODES: { mode: TeamMode; label: string; hint: string }[] = [
  { mode: 'worktree', label: 'Own branch', hint: 'Works in its own worktree on branch axo/<team>; merge when done.' },
  { mode: 'shared', label: 'Main checkout', hint: 'Works directly in the project folder, e.g. live server config.' },
];

export function NewTeamDialog() {
  const target = useAxo((s) => s.ui.newTeam);
  const setUi = useAxo((s) => s.setUi);
  const client = useAxo((s) => s.client);
  const nodes = useAxo((s) => s.nodes);
  const nodeOrder = useAxo((s) => s.nodeOrder);
  const [dest, setDest] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<TeamMode>('worktree');
  const [base, setBase] = useState('');
  const [goal, setGoal] = useState('');
  const [addAgent, setAddAgent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setName(''); setGoal(''); setBase(''); setError(null); setMode('worktree');
    setDest(`${target.nodeKey}|${target.projectId}`);
  }, [target]);
  const close = () => setUi({ newTeam: null });
  const online = nodeOrder.filter((k) => nodes[k].status === 'online');
  const projects = online.flatMap((k) => nodes[k].projects.map((p) => ({ value: `${k}|${p.id}`, label: online.length > 1 ? `${nodes[k].name} / ${p.name}` : p.name })));
  const [nodeKey, projectId] = dest.split('|');
  const project = nodes[nodeKey]?.projects.find((p) => p.id === projectId);
  const git = !!project?.isGit;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target || !project || busy) return;
    setBusy(true);
    setError(null);
    try {
      const req: CreateTeamReq = {
        projectId, name: name.trim(), mode: git ? mode : 'direct',
        base: git && mode === 'worktree' && base.trim() ? base.trim() : undefined,
        goal: goal.trim() || undefined,
      };
      const team = await client(nodeKey).post<Team>('/teams', req);
      close();
      if (addAgent) setUi({ newAgent: { nodeKey, projectId, teamId: team.id } });
    } catch (err: any) {
      setError(/already exists/i.test(err.message) ? 'A team with that name already exists in this project.'
        : /team name/i.test(err.message) ? 'Use up to 40 letters, numbers, spaces, . _ or -.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!target} onClose={close} title="New team" width={480}>
      <form onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input autoFocus required maxLength={40} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. payments" />
          </Field>
          <Field label="Project">
            <select className={inputCls} value={dest} onChange={(e) => setDest(e.target.value)}>
              {projects.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </Field>
        </div>
        {git ? (
          <Field label="Where it works">
            <div role="radiogroup" aria-label="Where it works" className="grid grid-cols-2 gap-2">
              {TEAM_MODES.map((m) => (
                <button key={m.mode} type="button" role="radio" aria-checked={mode === m.mode} onClick={() => setMode(m.mode)}
                  className={cn('rounded-[4px] border px-2.5 py-2 text-left cursor-pointer transition-colors',
                    mode === m.mode ? 'border-control-hover bg-control' : 'border-border hover:bg-hover')}>
                  <div className="text-[13px] text-primary">{m.label}</div>
                  <div className="mt-0.5 text-2xs leading-snug text-muted">{m.hint}</div>
                </button>
              ))}
            </div>
          </Field>
        ) : project && (
          <p className="mb-3 text-xs text-muted">{project.name} isn't a git repository, so the team works directly in the project folder.</p>
        )}
        {git && mode === 'worktree' && (
          <Field label="Branch from" hint={`Optional — defaults to ${project?.baseBranch ?? 'the current branch'}`}>
            <input className={inputCls} value={base} onChange={(e) => setBase(e.target.value)} placeholder={project?.baseBranch ?? 'HEAD'} />
          </Field>
        )}
        <Field label="Goal" hint="Optional — what this team is for. Its agents read it.">
          <textarea className={inputCls + ' min-h-20 resize-y'} value={goal} onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) void submit(e as any); }}
            placeholder="Ship the new checkout flow" />
        </Field>
        <label className="mb-3 flex items-center gap-2 text-xs text-secondary cursor-pointer">
          <input type="checkbox" checked={addAgent} onChange={(e) => setAddAgent(e.target.checked)} className="accent-[var(--accent)]" />
          Add an agent to it next
        </label>
        {error && <p className="mb-3 text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim() || !project}>{busy ? 'Creating…' : 'Create team'}</Button>
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
