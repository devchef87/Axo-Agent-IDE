import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { AlertTriangle, FileDiff, FileText, MessageSquarePlus, Search, X } from 'lucide-react';
import type { FileContent, FileSearchRes, FileWatchRes, WriteFileRes } from '@axo/protocol';
import { basename, dirname, fileKind, selectionMessage, tabKey, targetKey, targetStatus, type EditorTab, type EditorTarget } from '../../lib/editor-model.ts';
import { defaultTarget, fileQuery, isDirty, rawUrl, useEditor } from '../../stores/editor.ts';
import { focusedSel, onFilesChanged, tryClient, useAxo } from '../../stores/store.ts';
import { Button, cn, Kbd, useModalFocus } from '../ui.tsx';
import { CodeEditor, type Selection } from './code-editor.tsx';
import { DiffView } from './diff-view.tsx';
import { FileTree } from './file-tree.tsx';
import { Centered, MediaViewer } from './media-viewer.tsx';

const POLL_MS = 4000;        // fallback only, when the node can't watch
const LEASE_RENEW_MS = 60_000; // node lease lasts 5 minutes

export function EditorView() {
  const target = useEditor((s) => s.target);
  const setTarget = useEditor((s) => s.setTarget);
  const nodes = useAxo((s) => s.nodes);
  const status = target ? targetStatus(target, nodes[target.nodeKey]) : null;

  // Pick a project the first time; replace a target whose project is gone. A target on a
  // server that isn't connected yet is kept: it may connect any moment.
  useEffect(() => {
    if (status === 'waiting' || status === 'ok') return;
    const t = defaultTarget();
    if (t && (!target || targetKey(t) !== targetKey(target))) setTarget(t);
    else if (status === 'gone') setTarget(null);
  }, [status, target, setTarget]);

  // Only talk to the node once it's reachable.
  useEditorSync(status === 'ok' ? target : null);

  if (target && status === 'waiting') {
    const name = nodes[target.nodeKey]?.name ?? target.nodeKey;
    return (
      <Centered>
        <div className="flex flex-col items-center gap-1">
          <span className="text-secondary">{name} isn't connected.</span>
          <span>Its files will show here when it reconnects, or pick another project above.</span>
        </div>
      </Centered>
    );
  }
  if (!target) return <Centered>Add a project to browse its files.</Centered>;
  const node = nodes[target.nodeKey];
  const project = node?.projects.find((p) => p.id === target.projectId);
  const team = target.team ? node?.teams.find((t) => t.id === target.team) : undefined;
  const ownAgent = target.agent ? node?.agents.find((a) => a.id === target.agent) : undefined;
  const label = [project?.name, team?.name, ownAgent ? `${ownAgent.name}'s worktree` : null].filter(Boolean).join(' · ') || 'Files';

  return (
    <div className="flex h-full min-w-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border-subtle bg-panel">
        <FileTree key={targetKey(target)} target={target} label={label} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col bg-bg">
        <TabBar />
        <div className="min-h-0 flex-1"><ActiveTab target={target} /></div>
      </div>
      <QuickOpen target={target} />
    </div>
  );
}

/** Project (and worktree) picker shown in the view bar while the editor is active. */
export function EditorTargetPicker() {
  const target = useEditor((s) => s.target);
  const setTarget = useEditor((s) => s.setTarget);
  const nodes = useAxo((s) => s.nodes);
  const order = useAxo((s) => s.nodeOrder);
  const options = order.flatMap((k) => nodes[k].projects.flatMap((p) => [
    // value = node|project|team|agent
    { value: `${k}|${p.id}||`, label: order.length > 1 ? `${nodes[k].name} / ${p.name}` : p.name },
    ...nodes[k].teams.filter((t) => t.projectId === p.id && t.worktreePath && !t.archivedAt).flatMap((t) => [
      { value: `${k}|${p.id}|${t.id}|`, label: `${order.length > 1 ? `${nodes[k].name} / ` : ''}${p.name} · ${t.name} (team worktree)` },
      // Agents with their own worktree (own branch off the team branch).
      ...nodes[k].agents.filter((a) => a.teamId === t.id && a.workdir !== t.worktreePath)
        .map((a) => ({ value: `${k}|${p.id}||${a.id}`, label: `${order.length > 1 ? `${nodes[k].name} / ` : ''}${p.name} · ${t.name} · ${a.name} (own worktree)` })),
    ]),
  ]));
  if (!options.length) return null;
  const value = target ? `${target.nodeKey}|${target.projectId}|${target.agent ? '' : target.team ?? ''}|${target.agent ?? ''}` : '';
  return (
    <select
      aria-label="Project"
      value={value}
      onChange={(e) => { const [nodeKey, projectId, team, agent] = e.target.value.split('|'); setTarget({ nodeKey, projectId, team: team || null, agent: agent || null }); }}
      className="h-6 max-w-64 rounded border border-border bg-bg px-1.5 text-xs text-secondary outline-none focus:border-accent cursor-pointer"
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Keep open buffers in step with disk: files:changed (pushed by the node's watcher) and window focus. */
function useEditorSync(target: EditorTarget | null) {
  const client = useAxo((s) => s.client);
  const view = useAxo((s) => s.view);

  const refresh = useCallback(async (paths: string[]) => {
    if (!target) return;
    const ed = useEditor.getState();
    for (const path of paths) {
      if (!ed.buffers[path]) continue;
      try {
        const f = await client(target.nodeKey).get<FileContent>(`/projects/${target.projectId}/files/read${fileQuery(target, { path })}`);
        useEditor.getState().diskChanged(path, f);
      } catch (e: any) {
        if (/not found/i.test(e.message)) useEditor.getState().diskChanged(path, null);
      }
    }
  }, [client, target]);

  useEffect(() => {
    if (!target) return;
    // Agents can write many files in a burst: refresh open buffers at once, the tree at most once a second.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onFilesChanged((nodeKey, ev) => {
      if (nodeKey !== target.nodeKey || ev.projectId !== target.projectId) return;
      void refresh(ev.paths);
      timer ??= setTimeout(() => { timer = null; useEditor.getState().bump(); }, 1000);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [target, refresh]);

  // Agents edit files directly, not through the file API. The node watches the root while we hold
  // a lease (renewed every minute) and pushes files:changed; if it can't watch, poll the active file.
  useEffect(() => {
    if (!target || view !== 'editor') return;
    let poll: ReturnType<typeof setInterval> | null = null;
    let live = true;
    const startPolling = () => {
      if (poll) return;
      poll = setInterval(() => {
        if (document.hidden) return;
        const s = useEditor.getState();
        const tab = s.tabs[s.active];
        if (tab) void refresh([tab.path]);
      }, POLL_MS);
    };
    const renew = () => client(target.nodeKey)
      .post<FileWatchRes>(`/projects/${target.projectId}/files/watch${fileQuery(target)}`)
      .then((r) => { if (live && !r.watching) startPolling(); }, () => { if (live) startPolling(); });
    void renew();
    const lease = setInterval(() => void renew(), LEASE_RENEW_MS);
    const onFocus = () => { useEditor.getState().bump(); void refresh(Object.keys(useEditor.getState().buffers)); };
    window.addEventListener('focus', onFocus);
    return () => {
      live = false;
      clearInterval(lease);
      if (poll) clearInterval(poll);
      window.removeEventListener('focus', onFocus);
    };
  }, [target, view, refresh, client]);
}

function TabBar() {
  const tabs = useEditor((s) => s.tabs);
  const active = useEditor((s) => s.active);
  const buffers = useEditor((s) => s.buffers);
  const setActive = useEditor((s) => s.setActive);
  const close = useEditor((s) => s.close);
  const setQuickOpen = useEditor((s) => s.setQuickOpen);
  const ref = useRef<HTMLDivElement>(null);

  const tryClose = (i: number) => {
    const t = tabs[i];
    if (t.kind === 'file' && isDirty(buffers[t.path]) && !confirm(`${basename(t.path)} has unsaved changes. Close it anyway?`)) return;
    close(i);
  };

  useEffect(() => { ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [active]);

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border-subtle bg-panel">
      <div ref={ref} role="tablist" aria-label="Open files" className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((t, i) => {
          const dirty = t.kind === 'file' && isDirty(buffers[t.path]);
          const Icon = t.kind === 'diff' ? FileDiff : FileText;
          return (
            <div
              key={tabKey(t)}
              role="tab"
              aria-selected={i === active}
              tabIndex={i === active ? 0 : -1}
              title={t.kind === 'diff' ? `Changes in ${t.path}` : t.path}
              onClick={() => setActive(i)}
              onMouseDown={(e: MouseEvent) => { if (e.button === 1) { e.preventDefault(); tryClose(i); } }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') setActive(Math.min(i + 1, tabs.length - 1));
                if (e.key === 'ArrowLeft') setActive(Math.max(i - 1, 0));
              }}
              className={cn('group flex max-w-52 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border-subtle pl-3 pr-1.5 text-xs',
                i === active ? 'bg-bg text-primary shadow-[inset_0_2px_0_var(--accent)]' : 'text-muted hover:bg-hover hover:text-secondary')}
            >
              <Icon size={12} className={cn('shrink-0', t.kind === 'diff' ? 'text-warning' : 'text-faint')} />
              <span className="truncate">{basename(t.path)}</span>
              <button
                title={dirty ? 'Unsaved changes — close' : 'Close'}
                aria-label={`Close ${basename(t.path)}`}
                onClick={(e) => { e.stopPropagation(); tryClose(i); }}
                className="relative flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-control cursor-pointer"
              >
                {dirty && <span className="absolute h-2 w-2 rounded-full bg-secondary group-hover:hidden" />}
                <X size={11} className={cn(dirty ? 'hidden group-hover:block' : i === active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        onClick={() => setQuickOpen(true)}
        title="Go to file (⌘P)"
        className="flex shrink-0 items-center gap-1.5 border-l border-border-subtle px-3 text-2xs text-faint hover:bg-hover hover:text-secondary cursor-pointer"
      >
        <Search size={11} /> <Kbd>⌘P</Kbd>
      </button>
    </div>
  );
}

function ActiveTab({ target }: { target: EditorTarget }) {
  const tab = useEditor((s) => s.tabs[s.active] ?? null);
  const setQuickOpen = useEditor((s) => s.setQuickOpen);
  if (!tab) {
    return (
      <Centered>
        <div className="flex flex-col items-center gap-2">
          <span>Pick a file in the tree, or</span>
          <Button size="sm" onClick={() => setQuickOpen(true)}><Search size={11} /> Go to file <Kbd>⌘P</Kbd></Button>
        </div>
      </Centered>
    );
  }
  if (tab.kind === 'diff') return <DiffView key={tabKey(tab)} target={target} path={tab.path} />;
  const kind = fileKind(tab.path);
  if (kind !== 'text') return <MediaViewer key={tabKey(tab)} kind={kind} url={rawUrl(target, tab.path)} name={basename(tab.path)} />;
  return <TextTab key={tabKey(tab)} target={target} tab={tab} />;
}

function TextTab({ target, tab }: { target: EditorTarget; tab: EditorTab }) {
  const buffer = useEditor((s) => s.buffers[tab.path]);
  const { loaded, edit, saved, open } = useEditor.getState();
  const [meta, setMeta] = useState<{ binary: boolean; tooLarge: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const api = tryClient(target.nodeKey)!; // EditorView only renders tabs for a connected target
  const base = `/projects/${target.projectId}/files`;

  useEffect(() => {
    if (useEditor.getState().buffers[tab.path]) return;
    let live = true;
    api.get<FileContent>(`${base}/read${fileQuery(target, { path: tab.path })}`).then((f) => {
      if (!live) return;
      if (f.content === null) setMeta({ binary: f.binary, tooLarge: !f.binary });
      else loaded(tab.path, f);
    }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [tab.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (force = false) => {
    const b = useEditor.getState().buffers[tab.path];
    if (!b || saving || (!isDirty(b) && !force)) return;
    setSaving(true);
    setError(null);
    const content = b.content;
    try {
      const r = await api.post<WriteFileRes>(`${base}/write${fileQuery(target)}`, { path: tab.path, content, baseMtime: force ? undefined : b.mtime });
      saved(tab.path, content, r.mtime);
    } catch (e: any) {
      if (/changed on disk|deleted since/i.test(e.message)) useEditor.setState((s) => ({ buffers: { ...s.buffers, [tab.path]: { ...s.buffers[tab.path], conflict: /deleted/.test(e.message) ? 'deleted' : 'changed' } } }));
      else setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    try {
      const f = await api.get<FileContent>(`${base}/read${fileQuery(target, { path: tab.path })}`);
      if (f.content !== null) loaded(tab.path, f);
    } catch (e: any) { setError(e.message); }
  };

  const sendSelection = () => {
    const s = useAxo.getState();
    const sel = focusedSel(s);
    if (!sel || !selection || !buffer) return;
    const key = `axo.draft.${sel.nodeKey}.${sel.agentId}`;
    const prev = localStorage.getItem(key) ?? '';
    localStorage.setItem(key, (prev ? prev.replace(/\s*$/, '\n\n') : '') + selectionMessage(tab.path, selection.fromLine, selection.toLine, selection.text, buffer.language));
    s.setView('fleet');
  };
  const focusedAgent = useAxo((s) => { const f = focusedSel(s); return f ? s.nodes[f.nodeKey]?.agents.find((a) => a.id === f.agentId)?.name ?? null : null; });

  if (error && !buffer) return <Centered>{error}</Centered>;
  if (meta) {
    return (
      <Centered>
        <div className="flex flex-col items-center gap-2">
          <span>{meta.binary ? 'This looks like a binary file.' : 'This file is too large to edit here (over 5 MB).'}</span>
          <a className="text-accent underline" href={`${rawUrl(target, tab.path)}&download=1`} download>Download</a>
        </div>
      </Centered>
    );
  }
  if (!buffer) return <Centered>Loading…</Centered>;

  const dirty = isDirty(buffer);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {buffer.conflict && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-warning/10 px-3 py-1.5 text-xs text-warning">
          <AlertTriangle size={13} className="shrink-0" />
          <span className="flex-1">{buffer.conflict === 'deleted' ? 'This file was deleted on disk.' : 'This file changed on disk (maybe an agent edited it) while you had unsaved changes.'}</span>
          {buffer.conflict === 'changed' && <Button size="sm" variant="ghost" onClick={() => void reload()}>Discard mine, reload</Button>}
          <Button size="sm" variant="ghost" onClick={() => open({ kind: 'diff', path: tab.path })}>Compare with HEAD</Button>
          <Button size="sm" onClick={() => void save(true)}>{buffer.conflict === 'deleted' ? 'Save again' : 'Overwrite with mine'}</Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CodeEditor
          path={tab.path}
          content={buffer.content}
          onChange={(c) => edit(tab.path, c)}
          onSave={() => void save()}
          onSelection={setSelection}
        />
      </div>
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border-subtle bg-panel px-3 text-2xs text-faint">
        <span className="min-w-0 truncate" title={tab.path}>{dirname(tab.path) ? `${dirname(tab.path)}/` : ''}<span className="text-muted">{basename(tab.path)}</span></span>
        {error && <span className="text-danger">{error}</span>}
        <span className="ml-auto">{saving ? 'Saving…' : dirty ? 'Unsaved · ⌘S' : 'Saved'}</span>
        {selection && (
          <button
            disabled={!focusedAgent}
            title={focusedAgent ? `Add the selected lines to ${focusedAgent}'s message box` : 'Focus an agent pane in Fleet first'}
            onClick={sendSelection}
            className="flex items-center gap-1 rounded px-1 text-secondary hover:bg-hover hover:text-primary disabled:opacity-40 cursor-pointer"
          >
            <MessageSquarePlus size={11} /> Send {selection.fromLine === selection.toLine ? `L${selection.fromLine}` : `L${selection.fromLine}-${selection.toLine}`} to {focusedAgent ?? 'agent'}
          </button>
        )}
        <span>{buffer.language}</span>
      </div>
    </div>
  );
}

function QuickOpen({ target }: { target: EditorTarget }) {
  const open = useEditor((s) => s.quickOpen);
  const setOpen = useEditor((s) => s.setQuickOpen);
  const openTab = useEditor((s) => s.open);
  const client = useAxo((s) => s.client);
  const recent = useEditor((s) => s.tabs);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<FileSearchRes['files']>([]);
  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useModalFocus(panel, open, close);

  useEffect(() => { if (open) { setQ(''); setActive(0); setResults([]); } }, [open]);
  useEffect(() => {
    if (!open || !q.trim()) { setResults([]); return; }
    let live = true;
    const t = setTimeout(() => {
      client(target.nodeKey).get<FileSearchRes>(`/projects/${target.projectId}/files/search${fileQuery(target, { q, limit: '50' })}`)
        .then((r) => { if (live) { setResults(r.files); setActive(0); } }, () => {});
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [q, open, client, target]);

  const list = useMemo(
    () => (q.trim() ? results : recent.filter((t) => t.kind === 'file').map((t) => ({ path: t.path, name: basename(t.path) }))),
    [q, results, recent],
  );
  if (!open) return null;
  const pick = (path: string | undefined) => { if (!path) return; close(); openTab({ kind: 'file', path }); };

  return (
    <div className="no-drag fixed inset-0 z-50 flex items-start justify-center bg-[var(--overlay)] pt-[14vh]" onMouseDown={close}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label="Go to file" onMouseDown={(e) => e.stopPropagation()}
        className="animate-fade-in flex max-h-[60vh] w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-border bg-elevated shadow-pop">
        <div className="flex items-center gap-2 border-b border-border-subtle px-3">
          <Search size={14} className="shrink-0 text-faint" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, list.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              if (e.key === 'Enter') { e.preventDefault(); pick(list[active]?.path); }
            }}
            placeholder="Go to file…"
            className="h-11 flex-1 bg-transparent text-[13.5px] text-primary placeholder:text-faint outline-none"
          />
        </div>
        <div role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
          {list.length === 0 && <p className="px-4 py-6 text-center text-xs text-faint">{q.trim() ? 'No matching files' : 'Type to search files'}</p>}
          {list.map((f, i) => (
            <div key={f.path} role="option" aria-selected={i === active} onMouseMove={() => setActive(i)} onClick={() => pick(f.path)}
              className={cn('mx-1 flex h-8 cursor-pointer items-center gap-2 rounded-md px-2.5 text-[13px]', i === active ? 'bg-control text-primary' : 'text-secondary')}>
              <FileText size={13} className="shrink-0 text-faint" />
              <span className="shrink-0">{f.name}</span>
              <span className="min-w-0 truncate text-xs text-faint">{dirname(f.path)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

