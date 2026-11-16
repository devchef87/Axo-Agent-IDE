import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import {
  ChevronDown, ChevronRight, Copy, File, FileDiff, FilePlus, FolderPlus, Folder, FolderOpen, GitBranch, ListTree, Pencil, RefreshCw, Trash2,
} from 'lucide-react';
import type { FileEntry, FileTree as TreeRes, GitFileStatus, GitStatusRes, UploadRes } from '@axo/protocol';
import { basename, dirname, targetKey, type EditorTarget } from '../../lib/editor-model.ts';
import { fileQuery, useEditor } from '../../stores/editor.ts';
import { useAxo } from '../../stores/store.ts';
import { cn, IconButton, useDismiss } from '../ui.tsx';

const STATUS_CLS: Record<GitFileStatus, string> = {
  M: 'text-warning', A: 'text-success', '?': 'text-success', D: 'text-danger', R: 'text-info', U: 'text-danger',
};
const STATUS_LABEL: Record<GitFileStatus, string> = { M: 'modified', A: 'added', '?': 'untracked', D: 'deleted', R: 'renamed', U: 'conflict' };

type Pending = { kind: 'file' | 'dir'; parent: string } | { kind: 'rename'; path: string };
interface Menu { x: number; y: number; entry: FileEntry | null } // null = root

export function FileTree({ target, label }: { target: EditorTarget; label: string }) {
  const client = useAxo((s) => s.client);
  const rev = useEditor((s) => s.rev);
  const bump = useEditor((s) => s.bump);
  const open = useEditor((s) => s.open);
  const activePath = useEditor((s) => s.tabs[s.active]?.path);
  const renamed = useEditor((s) => s.renamed);
  const removed = useEditor((s) => s.removed);

  const storeKey = `axo.tree.${targetKey(target)}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem(storeKey) ?? '[]')));
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [git, setGit] = useState<GitStatusRes | null>(null);
  const [mode, setMode] = useState<'tree' | 'changes'>('tree');
  const [pending, setPending] = useState<Pending | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);

  const api = useCallback(() => client(target.nodeKey), [client, target.nodeKey]);
  const base = `/projects/${target.projectId}/files`;

  const loadDir = useCallback(async (path: string) => {
    try {
      const r = await api().get<TreeRes>(`${base}/tree${fileQuery(target, { path })}`);
      setChildren((c) => ({ ...c, [path]: r.entries }));
      setError(null);
    } catch (e: any) {
      if (path === '') setError(e.message);
      else setExpanded((s) => { const n = new Set(s); n.delete(path); return n; }); // folder vanished
    }
  }, [api, base, target]);

  // (Re)load the root and every expanded folder whenever the tree is invalidated.
  useEffect(() => {
    void loadDir('');
    for (const p of expanded) void loadDir(p);
    void api().get<GitStatusRes>(`${base}/git-status${fileQuery(target)}`).then(setGit, () => setGit(null));
  }, [rev, loadDir]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { localStorage.setItem(storeKey, JSON.stringify([...expanded])); }, [expanded, storeKey]);

  const status = useMemo(() => {
    const files = new Map<string, GitFileStatus>();
    const dirs = new Set<string>();
    for (const e of git?.entries ?? []) {
      const p = e.path.replace(/\/$/, '');
      files.set(p, e.status);
      for (let d = dirname(p); d; d = dirname(d)) dirs.add(d);
    }
    return { files, dirs };
  }, [git]);

  const toggle = (path: string) => {
    const opening = !expanded.has(path);
    setExpanded((s) => { const n = new Set(s); if (opening) n.add(path); else n.delete(path); return n; });
    if (opening && !children[path]) void loadDir(path);
  };
  const expand = (path: string) => {
    if (!path) return;
    setExpanded((s) => new Set([...s, path]));
    void loadDir(path);
  };

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); bump(); } catch (e: any) { setError(e.message); }
  };

  const commit = async (name: string) => {
    const p = pending;
    setPending(null);
    const clean = name.trim();
    if (!p || !clean) return;
    if (p.kind === 'rename') {
      const to = dirname(p.path) ? `${dirname(p.path)}/${clean}` : clean;
      if (to === p.path) return;
      await run(async () => { await api().post(`${base}/rename${fileQuery(target)}`, { from: p.path, to }); renamed(p.path, to); });
    } else {
      const path = p.parent ? `${p.parent}/${clean}` : clean;
      await run(async () => {
        await api().post(`${base}/create${fileQuery(target)}`, { path, dir: p.kind === 'dir' });
        if (p.kind === 'file') open({ kind: 'file', path });
      });
    }
  };

  const del = async (entry: FileEntry) => {
    if (!confirm(`Delete ${entry.dir ? 'folder' : 'file'} "${entry.path}"?${entry.dir ? '\n\nEverything inside it is deleted too.' : ''}`)) return;
    await run(async () => {
      await api().del(`${base}${fileQuery(target, { path: entry.path })}`);
      removed(entry.path);
    });
  };

  const upload = async (dir: string, files: FileList) => {
    const list = await Promise.all([...files].map((f) => new Promise<{ name: string; content: string }>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve({ name: f.name, content: String(r.result).split(',')[1] ?? '' });
      r.onerror = () => reject(r.error);
      r.readAsDataURL(f);
    })));
    await run(async () => {
      const res = await api().post<UploadRes>(`${base}/upload${fileQuery(target)}`, { dir, files: list });
      if (dir) expand(dir);
      if (res.uploaded.length === 1) open({ kind: 'file', path: res.uploaded[0].path });
    });
  };

  const onDrop = (dir: string) => (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    setDropDir(null);
    void upload(dir, e.dataTransfer.files);
  };
  const onDragOver = (dir: string) => (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDropDir(dir);
  };

  const openMenu = (entry: FileEntry | null) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const renderDir = (path: string, depth: number): React.ReactNode => {
    const list = children[path];
    const creating = pending && pending.kind !== 'rename' && pending.parent === path ? pending : null;
    return (
      <>
        {creating && <NameInput depth={depth} dir={creating.kind === 'dir'} initial="" onDone={commit} />}
        {list?.map((e) => {
          const st = e.dir ? (status.dirs.has(e.path) ? 'dot' : null) : status.files.get(e.path) ?? null;
          if (pending?.kind === 'rename' && pending.path === e.path) {
            return <NameInput key={e.path} depth={depth} dir={e.dir} initial={e.name} onDone={commit} />;
          }
          const isOpen = e.dir && expanded.has(e.path);
          return (
            <div key={e.path}>
              <Row
                entry={e}
                depth={depth}
                open={isOpen}
                active={!e.dir && e.path === activePath}
                status={st}
                drop={e.dir && dropDir === e.path}
                onClick={() => (e.dir ? toggle(e.path) : open({ kind: 'file', path: e.path }))}
                onContextMenu={openMenu(e)}
                onDragOver={e.dir ? onDragOver(e.path) : undefined}
                onDragLeave={() => setDropDir(null)}
                onDrop={e.dir ? onDrop(e.path) : undefined}
              />
              {isOpen && renderDir(e.path, depth + 1)}
            </div>
          );
        })}
        {list && list.length === 0 && !creating && depth > 0 && <div className="py-0.5 text-2xs text-faint" style={{ paddingLeft: 22 + depth * 12 }}>Empty</div>}
      </>
    );
  };

  const changes = git?.entries ?? [];

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col', dropDir === '' && 'bg-accent/5')}
      onDragOver={onDragOver('')}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropDir(null); }}
      onDrop={onDrop('')}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border-subtle pl-3 pr-1.5">
        <span className="min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-wide text-faint" title={label}>{label}</span>
        <IconButton title="New file" onClick={() => setPending({ kind: 'file', parent: '' })}><FilePlus size={13} /></IconButton>
        <IconButton title="New folder" onClick={() => setPending({ kind: 'dir', parent: '' })}><FolderPlus size={13} /></IconButton>
        <IconButton title="Refresh" onClick={bump}><RefreshCw size={12} /></IconButton>
      </div>
      {git?.isRepo && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border-subtle px-2 py-1 text-2xs" role="tablist">
          <ModeButton active={mode === 'tree'} onClick={() => setMode('tree')}><ListTree size={11} /> Files</ModeButton>
          <ModeButton active={mode === 'changes'} onClick={() => setMode('changes')}>
            <FileDiff size={11} /> Changes{changes.length > 0 && <span className="rounded bg-control px-1 text-secondary">{changes.length}</span>}
          </ModeButton>
          {git.branch && <span className="ml-auto flex min-w-0 items-center gap-1 truncate text-faint" title={`Branch ${git.branch}`}><GitBranch size={10} />{git.branch}</span>}
        </div>
      )}
      {error && <p role="alert" className="px-3 py-1.5 text-2xs text-danger">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto py-1" onContextMenu={openMenu(null)} role="tree" aria-label="Files">
        {mode === 'tree' ? renderDir('', 0) : (
          changes.length === 0 ? <p className="px-3 py-4 text-center text-2xs text-faint">No changes against HEAD.</p> : changes.map((c) => (
            <button
              key={c.path}
              onClick={() => open({ kind: c.status === 'D' ? 'diff' : c.status === '?' || c.status === 'A' ? 'file' : 'diff', path: c.path.replace(/\/$/, '') })}
              className="flex h-6 w-full items-center gap-2 px-3 text-left text-xs text-secondary hover:bg-hover cursor-pointer"
              title={`${c.path} — ${STATUS_LABEL[c.status]}`}
            >
              <span className="min-w-0 flex-1 truncate"><span className={STATUS_CLS[c.status]}>{basename(c.path.replace(/\/$/, ''))}</span> <span className="text-2xs text-faint">{dirname(c.path)}</span></span>
              <span className={cn('w-3 shrink-0 text-center font-mono text-2xs', STATUS_CLS[c.status])}>{c.status === '?' ? 'U' : c.status}</span>
            </button>
          ))
        )}
      </div>
      {menu && (
        <ContextMenu menu={menu} onClose={() => setMenu(null)} items={[
          ...(!menu.entry || menu.entry.dir ? [
            { icon: FilePlus, label: 'New file', run: () => { const p = menu.entry?.path ?? ''; if (p) expand(p); setPending({ kind: 'file', parent: p }); } },
            { icon: FolderPlus, label: 'New folder', run: () => { const p = menu.entry?.path ?? ''; if (p) expand(p); setPending({ kind: 'dir', parent: p }); } },
          ] : []),
          ...(menu.entry && !menu.entry.dir && status.files.has(menu.entry.path) && status.files.get(menu.entry.path) !== '?'
            ? [{ icon: FileDiff, label: 'Show changes', run: () => open({ kind: 'diff', path: menu.entry!.path }) }] : []),
          ...(menu.entry ? [
            { icon: Pencil, label: 'Rename', run: () => setPending({ kind: 'rename', path: menu.entry!.path }) },
            { icon: Copy, label: 'Copy path', run: () => void navigator.clipboard?.writeText(menu.entry!.path) },
            { icon: Trash2, label: 'Delete', danger: true, run: () => void del(menu.entry!) },
          ] : []),
        ]} />
      )}
    </div>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button role="tab" aria-selected={active} onClick={onClick}
      className={cn('flex items-center gap-1 rounded px-1.5 py-0.5 cursor-pointer', active ? 'bg-control text-primary' : 'text-muted hover:text-secondary')}>
      {children}
    </button>
  );
}

function Row({ entry, depth, open, active, status, drop, ...handlers }: {
  entry: FileEntry; depth: number; open: boolean; active: boolean; status: GitFileStatus | 'dot' | null; drop: boolean;
  onClick(): void; onContextMenu(e: MouseEvent): void;
  onDragOver?: (e: DragEvent) => void; onDragLeave(): void; onDrop?: (e: DragEvent) => void;
}) {
  const Icon = entry.dir ? (open ? FolderOpen : Folder) : File;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlers.onClick(); }
  };
  return (
    <div
      role="treeitem"
      aria-expanded={entry.dir ? open : undefined}
      aria-selected={active}
      tabIndex={0}
      onKeyDown={onKeyDown}
      {...handlers}
      title={entry.path}
      className={cn('flex h-6 cursor-pointer items-center gap-1 pr-2 text-xs outline-none focus-visible:bg-hover',
        active ? 'bg-accent/12 text-primary' : 'text-secondary hover:bg-hover', drop && 'bg-accent/15 ring-1 ring-inset ring-accent')}
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      {entry.dir ? (open ? <ChevronDown size={12} className="shrink-0 text-faint" /> : <ChevronRight size={12} className="shrink-0 text-faint" />) : <span className="w-3 shrink-0" />}
      <Icon size={13} className={cn('shrink-0', entry.dir ? 'text-muted' : 'text-faint')} />
      <span className={cn('min-w-0 flex-1 truncate', status && status !== 'dot' && STATUS_CLS[status])}>{entry.name}</span>
      {status === 'dot' && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-label="contains changes" />}
      {status && status !== 'dot' && (
        <span className={cn('shrink-0 font-mono text-2xs', STATUS_CLS[status])} title={STATUS_LABEL[status]}>{status === '?' ? 'U' : status}</span>
      )}
    </div>
  );
}

function NameInput({ depth, dir, initial, onDone }: { depth: number; dir: boolean; initial: string; onDone(name: string): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, !dir && dot > 0 ? dot : initial.length);
  }, [dir, initial]);
  const finish = (v: string) => { if (done.current) return; done.current = true; onDone(v); };
  const Icon = dir ? Folder : File;
  return (
    <div className="flex h-6 items-center gap-1 pr-2" style={{ paddingLeft: 6 + depth * 12 + 12 }}>
      <Icon size={13} className="shrink-0 text-faint" />
      <input
        ref={ref}
        defaultValue={initial}
        aria-label={dir ? 'Folder name' : 'File name'}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(e.currentTarget.value);
          if (e.key === 'Escape') { e.stopPropagation(); finish(''); }
        }}
        onBlur={(e) => finish(e.currentTarget.value === initial ? '' : e.currentTarget.value)}
        className="h-5 min-w-0 flex-1 rounded border border-accent bg-bg px-1 text-xs text-primary outline-none"
      />
    </div>
  );
}

function ContextMenu({ menu, items, onClose }: { menu: Menu; items: { icon: typeof File; label: string; run(): void; danger?: boolean }[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, true, onClose);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, []);
  if (!items.length) return null;
  const x = Math.min(menu.x, window.innerWidth - 200), y = Math.min(menu.y, window.innerHeight - items.length * 28 - 16);
  return (
    <div ref={ref} role="menu" className="fixed z-50 w-48 rounded-md border border-border bg-elevated py-1 shadow-pop" style={{ left: x, top: y }}
      onKeyDown={(e) => {
        const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
      }}>
      {items.map(({ icon: Icon, label, run, danger }) => (
        <button key={label} role="menuitem" onClick={() => { onClose(); run(); }}
          className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-hover focus-visible:bg-hover outline-none cursor-pointer', danger ? 'text-danger' : 'text-secondary')}>
          <Icon size={13} /> {label}
        </button>
      ))}
    </div>
  );
}
