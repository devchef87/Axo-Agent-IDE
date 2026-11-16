// App-level actions shared by keyboard shortcuts and the command palette.
import { focusedSel, useAxo } from '../stores/store.ts';
import { useEditor } from '../stores/editor.ts';

/** ⌘N: new agent in the focused agent's project, else the first project on an online node. */
export function openNewAgent(): void {
  const s = useAxo.getState();
  const sel = focusedSel(s);
  const agent = sel ? s.nodes[sel.nodeKey]?.agents.find((a) => a.id === sel.agentId) : undefined;
  if (sel && agent) return s.setUi({ newAgent: { nodeKey: sel.nodeKey, projectId: agent.projectId } });
  for (const k of s.nodeOrder) {
    const p = s.nodes[k].projects[0];
    if (p) return s.setUi({ newAgent: { nodeKey: k, projectId: p.id } });
  }
  // No projects anywhere yet: adding one is the first step.
  const node = s.nodeOrder.find((k) => s.nodes[k].status === 'online') ?? s.nodeOrder[0];
  if (node) s.setUi({ addProject: node });
}

export function toggleDrawer(): void {
  const s = useAxo.getState();
  s.setUi({ drawer: !s.ui.drawer });
}

/** Focus pane `i` and put the caret in its composer. */
export function focusPaneComposer(i: number): void {
  const s = useAxo.getState();
  if (i >= s.layout.panes.length) return;
  s.focusPane(i);
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-pane="${i}"] textarea`)?.focus());
}

/** Is any modal-like surface open? Global shortcuts (other than ⌘K) stand down while one is. */
export function modalOpen(): boolean {
  const ui = useAxo.getState().ui;
  if (useEditor.getState().quickOpen) return true;
  return !!ui.newAgent || !!ui.addProject || ui.palette || !!ui.refresh || !!ui.fork || !!ui.context || ui.servers;
}

/** ⌘E: switch between Fleet and Editor. */
export function toggleView(): void {
  const s = useAxo.getState();
  s.setView(s.view === 'editor' ? 'fleet' : 'editor');
}

/** ⌘P: go to file (switches to the editor). */
export function openQuickOpen(): void {
  useAxo.getState().setView('editor');
  useEditor.getState().setQuickOpen(true);
}
