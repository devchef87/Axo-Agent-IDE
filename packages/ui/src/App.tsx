import { useEffect } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useAxo } from './stores/store.ts';
import { isElectron, isMac } from './lib/bridge.ts';
import { Sidebar } from './components/sidebar.tsx';
import { ChatPane, Empty } from './components/chat-pane.tsx';
import { AddProjectDialog, NewAgentDialog } from './components/dialogs.tsx';
import { cn, ConnDot, formatTokens } from './components/ui.tsx';
import { useTheme, type ThemePref } from './lib/theme.ts';

export function App() {
  const init = useAxo((s) => s.init);
  const selected = useAxo((s) => s.selected);
  useEffect(() => { void init(); }, [init]);

  return (
    <div className="flex h-full flex-col">
      {isElectron && isMac && <TitleStrip />}
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

/**
 * macOS title strip: the only drag region in the app. Traffic lights sit at x:12 in the
 * first 80px, so that area stays empty. Nothing in here is clickable; never put .drag on
 * anything larger — Electron swallows clicks over drag regions, even under modals.
 */
function TitleStrip() {
  const crumbs = useAxo((s) => {
    const sel = s.selected;
    const node = sel ? s.nodes[sel.nodeKey] : undefined;
    const agent = node?.agents.find((a) => a.id === sel!.agentId);
    if (!node || !agent) return null;
    return [node.name, node.projects.find((p) => p.id === agent.projectId)?.name, agent.name].filter(Boolean).join('  /  ');
  });
  return (
    <div className="drag relative flex h-8 shrink-0 select-none items-center border-b border-border-subtle bg-panel pl-20 pr-3">
      <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-primary">
        <span className="h-2 w-2 rounded-full bg-accent" aria-hidden /> Axo
      </span>
      {crumbs && <span className="absolute inset-x-48 truncate text-center text-xs text-muted">{crumbs}</span>}
    </div>
  );
}

const THEME_OPTIONS: { pref: ThemePref; label: string; icon: typeof Sun }[] = [
  { pref: 'system', label: 'System', icon: Monitor },
  { pref: 'light', label: 'Light', icon: Sun },
  { pref: 'dark', label: 'Dark', icon: Moon },
];

function ThemeToggle() {
  const pref = useTheme((s) => s.pref);
  const theme = useTheme((s) => s.theme);
  const setPref = useTheme((s) => s.setPref);
  return (
    <div role="radiogroup" aria-label="Theme" className="flex items-center rounded border border-border-subtle">
      {THEME_OPTIONS.map(({ pref: p, label, icon: Icon }) => (
        <button
          key={p}
          role="radio"
          aria-checked={pref === p}
          title={p === 'system' ? `${label} theme (currently ${theme})` : `${label} theme`}
          onClick={() => setPref(p)}
          className={cn('flex h-4 w-5 items-center justify-center cursor-pointer transition-colors',
            pref === p ? 'bg-control text-primary' : 'text-faint hover:text-secondary')}
        >
          <Icon size={10} />
        </button>
      ))}
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
    <div className="flex h-6 shrink-0 items-center gap-4 border-t border-border-subtle bg-panel px-3 text-2xs text-muted">
      {order.map((k) => (
        <span key={k} className="flex items-center gap-1.5" title={nodes[k].error ?? nodes[k].status}>
          <ConnDot status={nodes[k].status} /> {nodes[k].name}
          {nodes[k].version && <span className="text-faint">v{nodes[k].version}</span>}
        </span>
      ))}
      <span className="ml-auto">{working} working · {all.length} agents</span>
      <span title="Tokens processed across current sessions">{formatTokens(tokens)} tok</span>
      <ThemeToggle />
    </div>
  );
}
