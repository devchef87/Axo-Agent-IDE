import { useState } from 'react';
import { ChevronDown, ChevronRight, FolderPlus, Plus, Server, Trash2 } from 'lucide-react';
import type { Agent, Project } from '@axo/protocol';
import { useAxo, type NodeView } from '../stores/store.ts';
import { cn, ConnDot, IconButton, StatusDot } from './ui.tsx';

export function Sidebar() {
  const nodeOrder = useAxo((s) => s.nodeOrder);
  const nodes = useAxo((s) => s.nodes);
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border-subtle bg-surface-1">
      <div className="flex-1 overflow-y-auto py-2">
        {nodeOrder.map((k) => <NodeSection key={k} node={nodes[k]} />)}
      </div>
    </aside>
  );
}

function NodeSection({ node }: { node: NodeView }) {
  const [open, setOpen] = useState(true);
  const setUi = useAxo((s) => s.setUi);
  return (
    <div className="mb-1">
      <div className="group flex h-7 items-center gap-1.5 px-2 text-xs font-semibold uppercase tracking-wide text-text-3">
        <button className="flex flex-1 items-center gap-1.5 cursor-pointer" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Server size={12} />
          <span className="truncate">{node.name}</span>
          <ConnDot status={node.status} />
        </button>
        <IconButton title="Add project" className="opacity-0 group-hover:opacity-100" onClick={() => setUi({ addProject: node.key })}>
          <FolderPlus size={13} />
        </IconButton>
      </div>
      {open && (
        <div>
          {node.status === 'unauthorized' && <p className="px-6 py-1 text-xs text-danger">Bad token for this node.</p>}
          {node.status === 'offline' && node.projects.length === 0 && <p className="px-6 py-1 text-xs text-text-3">Offline — retrying…</p>}
          {node.projects.map((p) => <ProjectSection key={p.id} node={node} project={p} />)}
          {node.status === 'online' && node.projects.length === 0 && (
            <button
              className="mx-3 mt-1 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-text-3 hover:border-accent/60 hover:text-text-1 cursor-pointer"
              onClick={() => setUi({ addProject: node.key })}
            >
              <FolderPlus size={13} /> Add a project
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
      <div className="group flex h-7 items-center gap-1 pl-4 pr-2 text-[13px] text-text-1 hover:bg-surface-3">
        <button className="flex min-w-0 flex-1 items-center gap-1.5 cursor-pointer" onClick={() => setOpen(!open)} title={project.path}>
          {open ? <ChevronDown size={12} className="text-text-3" /> : <ChevronRight size={12} className="text-text-3" />}
          <span className="truncate font-medium">{project.name}</span>
        </button>
        <IconButton title="Remove project" className="opacity-0 group-hover:opacity-100" onClick={remove}><Trash2 size={12} /></IconButton>
        <IconButton title="New agent" className="opacity-0 group-hover:opacity-100" onClick={() => setUi({ newAgent: { nodeKey: node.key, projectId: project.id } })}>
          <Plus size={13} />
        </IconButton>
      </div>
      {open && agents.map((a) => <AgentRow key={a.id} nodeKey={node.key} agent={a} />)}
      {open && agents.length === 0 && (
        <button
          className="flex h-7 w-full items-center gap-1.5 pl-9 text-xs text-text-3 hover:text-text-1 cursor-pointer"
          onClick={() => setUi({ newAgent: { nodeKey: node.key, projectId: project.id } })}
        >
          <Plus size={12} /> New agent
        </button>
      )}
    </div>
  );
}

function AgentRow({ nodeKey, agent }: { nodeKey: string; agent: Agent }) {
  const selected = useAxo((s) => s.selected?.nodeKey === nodeKey && s.selected.agentId === agent.id);
  const select = useAxo((s) => s.select);
  return (
    <button
      onClick={() => select({ nodeKey, agentId: agent.id })}
      className={cn(
        'flex h-7 w-full items-center gap-2 pl-9 pr-3 text-left text-[13px] cursor-pointer',
        selected ? 'bg-accent/12 text-text-0' : 'text-text-2 hover:bg-surface-3 hover:text-text-1',
      )}
    >
      <StatusDot status={agent.status} />
      <span className="truncate">{agent.name}</span>
      {agent.queued > 0 && <span className="ml-auto rounded bg-surface-5 px-1 text-2xs text-text-2">{agent.queued}</span>}
    </button>
  );
}
