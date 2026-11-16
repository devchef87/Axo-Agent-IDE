import { useEffect } from 'react';
import { useAxo } from './stores/store.ts';
import { isElectron, isMac } from './lib/bridge.ts';
import { Sidebar } from './components/sidebar.tsx';
import { ChatPane, Empty } from './components/chat-pane.tsx';
import { AddProjectDialog, NewAgentDialog } from './components/dialogs.tsx';
import { ConnDot, formatTokens } from './components/ui.tsx';

export function App() {
  const init = useAxo((s) => s.init);
  const selected = useAxo((s) => s.selected);
  useEffect(() => { void init(); }, [init]);

  return (
    <div className="flex h-full flex-col">
      {/* Only drag region in the app: the title strip (traffic lights live here on macOS). Never put drag on large areas — Electron swallows clicks over them, even under modals. */}
      {isElectron && isMac && <div className="drag h-8 shrink-0 bg-surface-1 border-b border-border-subtle flex items-center justify-center text-2xs font-semibold tracking-wider text-text-3 select-none">AXO</div>}
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        {selected ? <ChatPane key={`${selected.nodeKey}:${selected.agentId}`} sel={selected} /> : <Empty text="Select an agent, or create one from a project in the sidebar." />}
      </div>
      <StatusBar />
      <NewAgentDialog />
      <AddProjectDialog />
    </div>
  );
}

function StatusBar() {
  const nodes = useAxo((s) => s.nodes);
  const order = useAxo((s) => s.nodeOrder);
  const all = order.flatMap((k) => nodes[k].agents);
  const working = all.filter((a) => a.status === 'working' || a.status === 'starting').length;
  const tokens = all.reduce((n, a) => n + a.sessionTokens, 0);
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t border-border-subtle bg-surface-1 px-3 text-2xs text-text-3">
      {order.map((k) => (
        <span key={k} className="flex items-center gap-1.5" title={nodes[k].error ?? nodes[k].status}>
          <ConnDot status={nodes[k].status} /> {nodes[k].name}
          {nodes[k].version && <span className="text-text-4">v{nodes[k].version}</span>}
        </span>
      ))}
      <span className="ml-auto">{working} working · {all.length} agents</span>
      <span title="Tokens processed across current sessions">{formatTokens(tokens)} tok</span>
    </div>
  );
}
