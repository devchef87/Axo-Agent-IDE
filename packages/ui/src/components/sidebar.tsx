import { useRef, useState, type KeyboardEvent } from 'react';
import { BookOpen, ChevronDown, ChevronRight, FolderPlus, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { Agent, Project } from '@axo/protocol';
import { focusedSel, useAxo, useRefreshing, type NodeView } from '../stores/store.ts';
import { sameSel } from '../lib/layout.ts';
import { endAgentDrag, startAgentDrag } from '../lib/dnd.ts';
import { treeNav } from '../lib/tree-nav.ts';
import { cn, ConnDot, IconButton, StatusDot } from './ui.tsx';
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
  const setUi = useAxo((s) => s.setUi);
  return (
    <div className="mb-2">
      <div className="group flex h-8 items-center gap-1 pl-3 pr-1.5">
        <button data-nav data-level={1} data-label={node.name} aria-expanded={open} className="label flex min-w-0 flex-1 items-center gap-2 rounded-sm outline-none hover:!text-secondary focus-visible:bg-hover cursor-pointer" onClick={() => setOpen(!open)}>
          <ConnDot status={node.status} />
          <span className="truncate">{node.name}</span>
          {!open && <ChevronRight size={10} />}
        </button>
        <span className="font-mono text-2xs text-faint" title={`${node.agents.length} agents`}>{node.agents.length || ''}</span>
        <IconButton title="Add project" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => setUi({ addProject: node.key })}>
          <FolderPlus size={13} strokeWidth={1.75} />
        </IconButton>
      </div>
      {open && (
        <div>
          {node.status === 'unauthorized' && <p className="px-3 py-1 text-xs text-danger">Bad token for this node.</p>}
          {node.projects.map((p) => <ProjectSection key={p.id} node={node} project={p} />)}
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

function ProjectSection({ node, project }: { node: NodeView; project: Project }) {
  const [open, setOpen] = useState(true);
  const setUi = useAxo((s) => s.setUi);
  const client = useAxo((s) => s.client);
  const agents = node.agents.filter((a) => a.projectId === project.id);

  const remove = async () => {
    if (!confirm(`Remove project "${project.name}" from Axo?\n\nIts agents will be stopped and deleted. Files on disk are not touched.`)) return;
    await client(node.key).del(`/projects/${project.id}`);
  };

  return (
    <div>
      <div className="group flex h-7 items-center gap-0.5 pl-1.5 pr-1.5 text-[13px] text-primary hover:bg-hover">
        <button data-nav data-level={2} data-label={project.name} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1 rounded-sm outline-none focus-visible:bg-hover cursor-pointer" onClick={() => setOpen(!open)} title={project.path}>
          {open ? <ChevronDown size={12} className="shrink-0 text-faint" /> : <ChevronRight size={12} className="shrink-0 text-faint" />}
          <span className="truncate">{project.name}</span>
        </button>
        <IconButton title="Project map and decisions" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => setUi({ context: { nodeKey: node.key, projectId: project.id } })}>
          <BookOpen size={12} />
        </IconButton>
        <IconButton title="Remove project" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={remove}><Trash2 size={12} /></IconButton>
        <IconButton title="New agent" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => setUi({ newAgent: { nodeKey: node.key, projectId: project.id } })}>
          <Plus size={13} />
        </IconButton>
      </div>
      {open && agents.map((a) => <AgentRow key={a.id} nodeKey={node.key} agent={a} />)}
      {open && agents.length === 0 && (
        <button
          data-nav data-level={3} data-label="New agent"
          className="flex h-7 w-full items-center gap-2 pl-[26px] text-xs text-faint outline-none hover:bg-hover hover:text-secondary focus-visible:bg-hover cursor-pointer"
          onClick={() => setUi({ newAgent: { nodeKey: node.key, projectId: project.id } })}
        >
          <Plus size={12} /> New agent
        </button>
      )}
    </div>
  );
}

function AgentRow({ nodeKey, agent }: { nodeKey: string; agent: Agent }) {
  const sel = { nodeKey, agentId: agent.id };
  const focused = useAxo((s) => sameSel(focusedSel(s), sel));
  // Shown in some other pane (not the focused one).
  const visible = useAxo((s) => s.layout.panes.some((p) => sameSel(p, sel)));
  const select = useAxo((s) => s.select);
  const openInSplit = useAxo((s) => s.openInSplit);
  const refreshing = useRefreshing(sel);
  return (
    <button
      draggable
      onDragStart={(e) => startAgentDrag(e, sel, agent.name)}
      onDragEnd={endAgentDrag}
      onClick={(e) => (e.metaKey || e.ctrlKey ? openInSplit : select)(sel)}
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openInSplit(sel); } }}
      data-nav data-level={3} data-label={agent.name} data-agent={`${nodeKey}:${agent.id}`}
      title="Click or Enter to open · ⌘-click or ⌘Enter to open in a split · drag into a pane"
      aria-current={focused ? 'true' : undefined}
      className={cn(
        'relative flex h-7 w-full items-center gap-2.5 pl-[28px] pr-3 text-left text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent cursor-pointer',
        focused ? 'bg-control text-primary' : visible ? 'bg-hover text-primary' : 'text-secondary hover:bg-hover hover:text-primary',
      )}
    >
      {focused && <span className="absolute inset-y-0 left-0 w-px bg-accent" aria-hidden />}
      <StatusDot status={agent.status} />
      <span className="truncate">{agent.name}</span>
      {refreshing && <RefreshCw size={10} className="shrink-0 animate-spin text-rotating [animation-duration:2s]" aria-label="refreshing" />}
      {agent.queued > 0 && <span className="ml-auto font-mono text-2xs text-faint" title={`${agent.queued} queued`}>{agent.queued}</span>}
    </button>
  );
}
