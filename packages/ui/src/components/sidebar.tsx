import { useRef, useState, type KeyboardEvent } from 'react';
import { BookOpen, ChevronDown, ChevronRight, Columns2, FolderPlus, Pencil, Plus, RefreshCw, Settings2, Square, Trash2, UsersRound } from 'lucide-react';
import type { Agent, Project, Team } from '@axo/protocol';
import { focusedSel, useAxo, useRefreshing, type NodeView } from '../stores/store.ts';
import { sameSel } from '../lib/layout.ts';
import { endAgentDrag, startAgentDrag } from '../lib/dnd.ts';
import { treeNav } from '../lib/tree-nav.ts';
import { cn, ConnDot, ContextMenu, IconButton, StatusDot } from './ui.tsx';
import { groupByTeam } from '../lib/team-groups.ts';
import { ResizeHandle, usePanelWidth } from './resize.tsx';
import { ServersSidebarEntry } from './servers/sidebar-entry.tsx';

export function Sidebar() {
  const nodeOrder = useAxo((s) => s.nodeOrder);
  const nodes = useAxo((s) => s.nodes);
  const list = useRef<HTMLDivElement>(null);
  // The editor wants room for code, so it keeps its own (narrower) sidebar width.
  const editor = useAxo((s) => s.view === 'editor');
  const size = usePanelWidth(editor ? 'sidebar-editor' : 'sidebar', editor ? 200 : 232, 150, 480);

  // Arrow keys move between rows, Right/Left expand/collapse or go to the parent,
  // Home/End jump, letters jump to the next matching name. Enter opens (⌘Enter: split).
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !list.current) return;
    const rows = [...list.current.querySelectorAll<HTMLElement>('[data-nav]')];
    const cur = rows.indexOf(document.activeElement as HTMLElement);
    if (cur === -1) return;
    const act = treeNav(rows.map((el) => ({
      level: Number(el.dataset.level),
      expanded: el.hasAttribute('aria-expanded') ? el.getAttribute('aria-expanded') === 'true' : null,
      label: el.dataset.label ?? el.textContent ?? '',
    })), cur, e.key);
    if (!act) return;
    e.preventDefault();
    if ('focus' in act) { rows[act.focus].focus(); rows[act.focus].scrollIntoView({ block: 'nearest' }); }
    else rows[act.toggle].click();
  };

  return (
    <aside style={{ width: size.width }} className="relative flex h-full shrink-0 flex-col border-r border-border-subtle bg-panel">
      <ResizeHandle edge="right" width={size.width} onResize={size.set} onReset={size.reset} label="Resize sidebar" />
      <div ref={list} id="axo-sidebar" aria-label="Servers, projects and agents" onKeyDown={onKeyDown} className="flex-1 overflow-y-auto py-1.5">
        {/* A server that's down with nothing cached stays out of the way; the status bar shows its state. */}
        {nodeOrder.filter((k) => nodes[k].status === 'online' || nodes[k].status === 'unauthorized' || nodes[k].projects.length > 0)
          .map((k) => <NodeSection key={k} node={nodes[k]} />)}
      </div>
      <ServersSidebarEntry />
    </aside>
  );
}

function NodeSection({ node }: { node: NodeView }) {
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const setUi = useAxo((s) => s.setUi);
  const client = useAxo((s) => s.client);
  const sel = useAxo((s) => focusedSel(s));
  const multiProject = node.projects.length > 1;
  // Server → team → agent. Projects stay out of the tree; with several, each team names its project.
  const groups = node.projects.flatMap((p) => groupByTeam(p.id, node.agents, node.teams).map((g) => ({ ...g, project: p })));
  // New team goes to the project you're working in on this server, else its first project.
  const newTeam = () => {
    const agent = sel?.nodeKey === node.key ? node.agents.find((a) => a.id === sel.agentId) : undefined;
    const projectId = agent?.projectId ?? node.projects[0]?.id;
    if (projectId) setUi({ newTeam: { nodeKey: node.key, projectId } });
  };
  const removeProject = async (p: Project) => {
    if (!confirm(`Remove project "${p.name}" from Axo?\n\nIts teams and agents will be stopped and deleted. Files on disk are not touched.`)) return;
    await client(node.key).del(`/projects/${p.id}`);
  };

  return (
    <div className="mb-2">
      <div className="group flex h-8 items-center gap-1 pl-3 pr-1.5" onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
        <button data-nav data-level={1} data-label={node.name} aria-expanded={open}
          className="label flex min-w-0 flex-1 items-center gap-2 rounded-sm outline-none hover:!text-secondary focus-visible:bg-hover cursor-pointer"
          onClick={() => setOpen(!open)}
          title={node.projects.map((p) => p.path).join('\n') || node.name}>
          <ConnDot status={node.status} />
          <span className="truncate">{node.name}</span>
          {!open && <ChevronRight size={10} />}
        </button>
        <span className="font-mono text-2xs text-faint group-hover:hidden group-focus-within:hidden" title={`${node.agents.length} agents`}>{node.agents.length || ''}</span>
        {node.projects.length > 0 && (
          <span className="hidden group-hover:flex group-focus-within:flex">
            <IconButton title="New team" onClick={newTeam}><Plus size={13} /></IconButton>
          </span>
        )}
      </div>
      {menu && (
        <ContextMenu menu={menu} onClose={() => setMenu(null)} items={[
          ...(node.projects.length ? [{ icon: UsersRound, label: 'New team', run: newTeam }] : []),
          { icon: FolderPlus, label: 'Add project', run: () => setUi({ addProject: node.key }) },
          ...node.projects.map((p) => ({ icon: BookOpen, label: multiProject ? `Map & decisions · ${p.name}` : 'Map & decisions', run: () => setUi({ context: { nodeKey: node.key, projectId: p.id } }) })),
          ...node.projects.map((p) => ({ icon: Trash2, label: multiProject ? `Remove ${p.name}` : 'Remove project', danger: true, run: () => void removeProject(p) })),
        ]} />
      )}
      {open && (
        <div>
          {node.status === 'unauthorized' && <p className="px-3 py-1 text-xs text-danger">Bad token for this node.</p>}
          {groups.map((g) => (g.team
            ? <TeamSection key={g.team.id} node={node} project={g.project} team={g.team} agents={g.agents} showProject={multiProject} />
            : g.agents.map((a) => <AgentRow key={a.id} nodeKey={node.key} agent={a} />)))}
          {node.status === 'online' && node.projects.length === 0 && (
            <button
              data-nav data-level={2} data-label="Add a project"
              className="flex h-7 w-full items-center gap-2 px-3 text-xs text-faint outline-none hover:bg-hover hover:text-secondary focus-visible:bg-hover cursor-pointer"
              onClick={() => setUi({ addProject: node.key })}
            >
              <Plus size={12} /> Add project
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TeamSection({ node, project, team, agents, showProject }: { node: NodeView; project: Project; team: Team; agents: Agent[]; showProject: boolean }) {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const setUi = useAxo((s) => s.setUi);
  const client = useAxo((s) => s.client);
  const newAgent = () => setUi({ newAgent: { nodeKey: node.key, projectId: project.id, teamId: team.id } });
  const rename = (name: string) => client(node.key).patch(`/teams/${team.id}`, { name }).then(() => {});
  const working = agents.filter((a) => a.status === 'working' || a.status === 'starting').length;

  return (
    <div>
      <div className="group flex h-7 items-center gap-0.5 pl-1.5 pr-1.5 text-[13px] text-primary hover:bg-hover"
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
        {editing ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <ChevronDown size={12} className="shrink-0 text-faint" />
            <RenameInput initial={team.name} onSave={rename} onDone={() => setEditing(false)} />
          </div>
        ) : (
          <button data-nav data-level={2} data-label={team.name} aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-1 rounded-sm outline-none focus-visible:bg-hover cursor-pointer"
            onClick={() => setOpen(!open)} onDoubleClick={() => setEditing(true)}
            onKeyDown={(e) => { if (e.key === 'F2') { e.preventDefault(); setEditing(true); } }}
            title={`${team.name} · ${project.name}${team.branch ? ` · ${team.branch}` : ''} · double-click to rename`}>
            {open ? <ChevronDown size={12} className="shrink-0 text-faint" /> : <ChevronRight size={12} className="shrink-0 text-faint" />}
            <span className="truncate">{team.name}</span>
            {showProject && <span className="shrink-0 truncate text-xs text-faint">· {project.name}</span>}
          </button>
        )}
        {!editing && (
          <span className="pr-1 font-mono text-2xs text-faint group-hover:hidden group-focus-within:hidden" title={`${agents.length} agents${working ? `, ${working} working` : ''}`}>
            {agents.length || ''}
          </span>
        )}
        {!editing && (
          <span className="hidden group-hover:flex group-focus-within:flex">
            <IconButton title="Rename team (F2)" onClick={() => setEditing(true)}><Pencil size={11} /></IconButton>
            <IconButton title="New agent in this team" onClick={newAgent}><Plus size={13} /></IconButton>
          </span>
        )}
      </div>
      {menu && (
        <ContextMenu menu={menu} onClose={() => setMenu(null)} items={[
          { icon: Plus, label: 'New agent', run: newAgent },
          { icon: Pencil, label: 'Rename team', hint: 'F2', run: () => setEditing(true) },
          { icon: UsersRound, label: 'New team', run: () => setUi({ newTeam: { nodeKey: node.key, projectId: project.id } }) },
          { icon: BookOpen, label: 'Map & decisions', run: () => setUi({ context: { nodeKey: node.key, projectId: project.id } }) },
        ]} />
      )}
      {open && agents.map((a) => <AgentRow key={a.id} nodeKey={node.key} agent={a} />)}
      {open && agents.length === 0 && (
        <button
          data-nav data-level={3} data-label="New agent"
          className="flex h-7 w-full items-center gap-2 pl-[28px] text-xs text-faint outline-none hover:bg-hover hover:text-secondary focus-visible:bg-hover cursor-pointer"
          onClick={newAgent}
        >
          <Plus size={12} /> New agent
        </button>
      )}
    </div>
  );
}

/** Inline name editor: Enter saves, Escape cancels, clicking away saves. Errors from the node show under it. */
function RenameInput({ initial, onSave, onDone }: { initial: string; onSave(name: string): Promise<void>; onDone(): void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const commit = async () => {
    const name = value.trim();
    if (!name || name === initial) { onDone(); return; }
    setBusy(true);
    try { await onSave(name); onDone(); } catch (e: any) { setError(friendlyNameError(e?.message)); setBusy(false); }
  };
  return (
    <div className="min-w-0 flex-1 py-0.5">
      <input
        autoFocus
        aria-label="New name"
        aria-invalid={!!error}
        value={value}
        readOnly={busy} // not disabled: a disabled input drops focus, and Escape would stop working after an error
        maxLength={40}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => { setValue(e.target.value); setError(null); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); void commit(); }
          if (e.key === 'Escape') { e.preventDefault(); onDone(); }
        }}
        onBlur={() => (error ? onDone() : void commit())}
        className={cn('h-5 w-full rounded-[3px] border bg-inset px-1.5 text-[13px] text-primary outline-none', error ? 'border-danger' : 'border-control-hover')}
      />
      {error && <div className="pt-0.5 text-2xs leading-tight text-danger">{error}</div>}
    </div>
  );
}

function friendlyNameError(msg = ''): string {
  if (/taken|already exists/i.test(msg)) return 'That name is already used in this project.';
  if (/invalid name/i.test(msg)) return 'Use up to 40 letters, numbers, . _ or -.';
  return msg || 'Rename failed.';
}

function AgentRow({ nodeKey, agent }: { nodeKey: string; agent: Agent }) {
  const sel = { nodeKey, agentId: agent.id };
  const focused = useAxo((s) => sameSel(focusedSel(s), sel));
  // Shown in some other pane (not the focused one).
  const visible = useAxo((s) => s.layout.panes.some((p) => sameSel(p, sel)));
  const select = useAxo((s) => s.select);
  const openInSplit = useAxo((s) => s.openInSplit);
  const setUi = useAxo((s) => s.setUi);
  const client = useAxo((s) => s.client);
  const refreshing = useRefreshing(sel);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const indent = 'pl-[28px]';
  const running = agent.status === 'working' || agent.status === 'starting' || agent.status === 'idle' || agent.status === 'rotating';

  const rename = (name: string) => client(nodeKey).patch(`/agents/${agent.id}`, { name }).then(() => {});
  const remove = async () => {
    if (!confirm(`Delete agent "${agent.name}"?\n\nIts process is stopped, its chat history is deleted and its watches are cancelled. Files on disk are not touched.`)) return;
    try { await client(nodeKey).del(`/agents/${agent.id}`); } catch (e: any) { alert(`Couldn't delete ${agent.name}: ${e.message}`); }
  };

  if (editing) {
    return (
      <div className={cn('flex min-h-7 w-full items-center gap-2.5 pr-3', indent, focused && 'bg-control')}>
        <StatusDot status={agent.status} />
        <RenameInput initial={agent.name} onSave={rename} onDone={() => setEditing(false)} />
      </div>
    );
  }

  return (
    <>
      <button
        draggable
        onDragStart={(e) => startAgentDrag(e, sel, agent.name)}
        onDragEnd={endAgentDrag}
        onClick={(e) => (e.metaKey || e.ctrlKey ? openInSplit : select)(sel)}
        onDoubleClick={() => setEditing(true)}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openInSplit(sel); }
          if (e.key === 'F2') { e.preventDefault(); setEditing(true); }
          if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey))) { e.preventDefault(); void remove(); }
        }}
        data-nav data-level={3} data-label={agent.name} data-agent={`${nodeKey}:${agent.id}`}
        title="Click to open · ⌘-click for a split · double-click or F2 to rename · right-click for more"
        aria-current={focused ? 'true' : undefined}
        className={cn(
          'relative flex h-7 w-full items-center gap-2.5 pr-3 text-left text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent cursor-pointer', indent,
          focused ? 'bg-control text-primary' : visible ? 'bg-hover text-primary' : 'text-secondary hover:bg-hover hover:text-primary',
        )}
      >
        {focused && <span className="absolute inset-y-0 left-0 w-px bg-accent" aria-hidden />}
        <StatusDot status={agent.status} />
        <span className="truncate">{agent.name}</span>
        {refreshing && <RefreshCw size={10} className="shrink-0 animate-spin text-rotating [animation-duration:2s]" aria-label="refreshing" />}
        {agent.queued > 0 && <span className="ml-auto font-mono text-2xs text-faint" title={`${agent.queued} queued`}>{agent.queued}</span>}
      </button>
      {menu && (
        <ContextMenu menu={menu} onClose={() => setMenu(null)} items={[
          { icon: Columns2, label: 'Open in split', hint: '⌘-click', run: () => openInSplit(sel) },
          { icon: Pencil, label: 'Rename', hint: 'F2', run: () => setEditing(true) },
          { icon: Settings2, label: 'Agent settings', run: () => { select(sel); setUi({ drawer: true }); } },
          ...(running ? [{ icon: Square, label: 'Stop process', run: () => void client(nodeKey).post(`/agents/${agent.id}/stop`) }] : []),
          { icon: Trash2, label: 'Delete agent', danger: true, hint: '⌦', run: () => void remove() },
        ]} />
      )}
    </>
  );
}
