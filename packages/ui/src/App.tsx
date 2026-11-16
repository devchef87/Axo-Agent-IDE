import { useEffect } from 'react';
import { lazy, Suspense } from 'react';
import { Code2, Eye, GitMerge, Monitor, Moon, Search, Sun, Users } from 'lucide-react';
import { focusedSel, useAxo } from './stores/store.ts';
import { isElectron, isMac } from './lib/bridge.ts';
import { Sidebar } from './components/sidebar.tsx';
import { Fleet } from './components/fleet.tsx';
import { ErrorBoundary } from './components/error-boundary.tsx';
import { AgentDrawer } from './components/agent-drawer.tsx';
import { CommandPalette } from './components/palette.tsx';
import { focusPaneComposer, focusSidebar, modalOpen, openNewAgent, openQuickOpen, toggleDrawer, toggleView } from './lib/actions.ts';
import { AddProjectDialog, ForkDialog, NewAgentDialog, RefreshDialog } from './components/dialogs.tsx';
import { ProjectContextDialog } from './components/project-context.tsx';
import { cn, ConnDot, formatTokens } from './components/ui.tsx';
import { useTheme, type ThemePref } from './lib/theme.ts';
import { ServersPanel } from './components/servers/servers-panel.tsx';
import { startNotifications } from './lib/notifications.ts';
import { TeamsView } from './components/teams/teams-view.tsx';
import { WatchesView } from './components/watches/watches-view.tsx';
import { useActiveWatchCount, useWatchSync } from './stores/watches.ts';
import { formatUsd, totalTokens, useNodeToday, useUsage, useUsageSync } from './stores/usage.ts';

export function App() {
  const init = useAxo((s) => s.init);
  const drawer = useAxo((s) => s.ui.drawer);
  const view = useAxo((s) => s.view);
  useEffect(() => { void init(); }, [init]);
  useEffect(() => { startNotifications(); }, []);
  useGlobalShortcuts();
  useWatchSync();
  useUsageSync();

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <ErrorBoundary resetKey={view} label={view === 'fleet' ? 'Fleet' : view[0].toUpperCase() + view.slice(1)} onReset={view === 'fleet' ? undefined : () => useAxo.getState().setView('fleet')}>
            {view === 'editor' ? (
              <Suspense fallback={<div className="flex-1 bg-bg" />}><EditorView /></Suspense>
            ) : view === 'teams' ? (
              <TeamsView />
            ) : view === 'watches' ? (
              <WatchesView />
            ) : (
              <>
                <Fleet />
                {drawer && <AgentDrawer />}
              </>
            )}
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <StatusBar />
      <NewAgentDialog />
      <AddProjectDialog />
      <RefreshDialog />
      <ForkDialog />
      <ProjectContextDialog />
      <CommandPalette />
      <ServersPanel />
    </div>
  );
}

// The editor (CodeMirror, language data) loads on first use; pdf.js loads only for PDFs.
const EditorView = lazy(() => import('./components/editor/editor-view.tsx').then((m) => ({ default: m.EditorView })));

const VIEWS = [
  { id: 'fleet' as const, label: 'Fleet', icon: Users },
  { id: 'editor' as const, label: 'Editor', icon: Code2 },
  { id: 'teams' as const, label: 'Teams', icon: GitMerge },
  { id: 'watches' as const, label: 'Watches', icon: Eye },
];


/**
 * The one bar at the top: wordmark, views, where you are, and search. On macOS it is also
 * the window's drag region (the only one; Electron swallows clicks over drag regions, even
 * under modals), with the traffic lights centred in the first 84px. Controls opt out with .no-drag.
 */
function TitleBar() {
  const view = useAxo((s) => s.view);
  const setView = useAxo((s) => s.setView);
  const setUi = useAxo((s) => s.setUi);
  const activeWatches = useActiveWatchCount();
  const mac = isElectron && isMac;
  const crumbs = useAxo((s) => {
    const sel = focusedSel(s);
    const node = sel ? s.nodes[sel.nodeKey] : undefined;
    const agent = node?.agents.find((a) => a.id === sel!.agentId);
    if (!node || !agent) return null;
    return [node.name, node.projects.find((p) => p.id === agent.projectId)?.name, agent.name].filter(Boolean).join(' / ');
  });
  return (
    <header className={cn('relative flex h-[38px] shrink-0 select-none items-center gap-3 border-b border-border-subtle bg-panel pr-2', mac ? 'drag pl-[84px]' : 'pl-3')}>
      <span className="label !text-primary !tracking-[0.18em]">Axo</span>
      <nav role="tablist" aria-label="View" className="no-drag flex items-center">
        {VIEWS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={view === id}
            title={id === 'fleet' || id === 'editor' ? `${label} · ⌘E switches Fleet/Editor` : label}
            onClick={() => setView(id)}
            className={cn('relative flex h-[38px] items-center gap-1.5 px-2.5 text-xs cursor-pointer transition-colors',
              view === id ? 'text-primary' : 'text-faint hover:text-secondary')}
          >
            <Icon size={13} strokeWidth={1.75} /> {label}
            {id === 'watches' && activeWatches > 0 && <span className="font-mono text-2xs text-secondary">{activeWatches}</span>}
            {view === id && <span className="absolute inset-x-2.5 bottom-0 h-px bg-accent" aria-hidden />}
          </button>
        ))}
      </nav>
      <span className="min-w-0 flex-1 truncate text-center font-mono text-2xs text-faint">{crumbs}</span>
      <button
        onClick={() => setUi({ palette: true })}
        title="Search agents, projects and commands"
        className="no-drag flex h-6 w-56 shrink items-center gap-2 rounded border border-border bg-bg px-2 text-xs text-faint hover:border-border-strong hover:text-secondary cursor-pointer"
      >
        <Search size={12} /> Search or jump to…
        <span className="ml-auto font-mono text-2xs">⌘K</span>
      </button>
    </header>
  );
}

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
      const k = e.key.toLowerCase();
      if (k === 'k' && !e.shiftKey) {
        const s = useAxo.getState();
        if (!s.ui.palette && modalOpen()) return;
        e.preventDefault();
        s.setUi({ palette: !s.ui.palette });
        return;
      }
      if (modalOpen()) return;
      if (k === 'n' && !e.shiftKey) { e.preventDefault(); openNewAgent(); }
      else if (k === 'e' && !e.shiftKey) { e.preventDefault(); toggleView(); }
      else if (k === 'l' && !e.shiftKey) { e.preventDefault(); focusSidebar(); } // ⌘0 is the menu's reset-zoom
      else if (k === 'p' && !e.shiftKey) { e.preventDefault(); openQuickOpen(); }
      else if (k === 'i' && !e.shiftKey) { e.preventDefault(); useAxo.getState().setView('fleet'); toggleDrawer(); }
      else if (/^[1-3]$/.test(k)) { e.preventDefault(); useAxo.getState().setView('fleet'); focusPaneComposer(Number(k) - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
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

function NodeStatus({ nodeKey }: { nodeKey: string }) {
  const node = useAxo((s) => s.nodes[nodeKey]);
  const today = useNodeToday(nodeKey);
  return (
    <span className="flex shrink-0 items-center gap-1.5"
      title={[node.error ?? node.status, node.version ? `v${node.version}` : null,
        today ? `today: ${formatTokens(totalTokens(today))} tokens, ${formatUsd(today.costUsd)}, ${today.turns} turns` : null].filter(Boolean).join(' · ')}>
      <ConnDot status={node.status} /> <span className={node.status === 'online' ? 'text-secondary' : undefined}>{node.name}</span>
    </span>
  );
}

function StatusBar() {
  const nodes = useAxo((s) => s.nodes);
  const order = useAxo((s) => s.nodeOrder);
  const all = order.flatMap((k) => nodes[k].agents);
  const working = all.filter((a) => a.status === 'working' || a.status === 'starting').length;
  const byNode = useUsage((s) => s.byNode);
  const todayTok = order.reduce((n, k) => n + totalTokens(byNode[k]?.total), 0);
  const todayCost = order.reduce((n, k) => n + (byNode[k]?.total.costUsd ?? 0), 0);
  const setView = useAxo((s) => s.setView);
  const activeWatches = useActiveWatchCount();
  const seg = 'flex h-full items-center gap-1.5 border-l border-border-subtle px-3';
  return (
    <footer className="flex h-6 shrink-0 items-stretch border-t border-border-subtle bg-panel font-mono text-2xs text-faint">
      <div className="flex min-w-0 items-center gap-3 px-3">
        {order.map((k) => <NodeStatus key={k} nodeKey={k} />)}
      </div>
      <div className="ml-auto flex items-stretch">
        <span className={seg} title={`${working} working of ${all.length} agents`}>
          {working > 0 && <span className="h-1.5 w-1.5 rounded-full bg-working animate-pulse-dot" aria-hidden />}
          <span className="text-secondary">{working}</span>/{all.length} working
        </span>
        {activeWatches > 0 && (
          <button className={cn(seg, 'hover:bg-hover hover:text-secondary cursor-pointer')} title="Open Watches" onClick={() => setView('watches')}>
            <Eye size={10} /> <span className="text-secondary">{activeWatches}</span> watch{activeWatches === 1 ? '' : 'es'}
          </button>
        )}
        <span className={seg} title={`Today across ${order.length === 1 ? 'this node' : 'all nodes'}`}>
          today <span className="text-secondary">{formatTokens(todayTok)}</span> tok <span className="text-secondary">{formatUsd(todayCost)}</span>
        </span>
        <span className={cn(seg, 'pr-2')}><ThemeToggle /></span>
      </div>
    </footer>
  );
}
