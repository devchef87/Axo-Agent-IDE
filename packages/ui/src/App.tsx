import { useEffect } from 'react';
import { Monitor, Moon, Search, Sun } from 'lucide-react';
import { focusedSel, useAxo } from './stores/store.ts';
import { isElectron, isMac } from './lib/bridge.ts';
import { Sidebar } from './components/sidebar.tsx';
import { Fleet } from './components/fleet.tsx';
import { AgentDrawer } from './components/agent-drawer.tsx';
import { CommandPalette } from './components/palette.tsx';
import { focusPaneComposer, modalOpen, openNewAgent, toggleDrawer } from './lib/actions.ts';
import { AddProjectDialog, NewAgentDialog } from './components/dialogs.tsx';
import { cn, ConnDot, formatTokens } from './components/ui.tsx';
import { useTheme, type ThemePref } from './lib/theme.ts';
import { ServersPanel } from './components/servers/servers-panel.tsx';

export function App() {
  const init = useAxo((s) => s.init);
  const drawer = useAxo((s) => s.ui.drawer);
  useEffect(() => { void init(); }, [init]);
  useGlobalShortcuts();

  return (
    <div className="flex h-full flex-col">
      {isElectron && isMac && <TitleStrip />}
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <Fleet />
        {drawer && <AgentDrawer />}
      </div>
      <StatusBar />
      <NewAgentDialog />
      <AddProjectDialog />
      <CommandPalette />
      <ServersPanel />
    </div>
  );
}

/**
 * macOS title strip: the only drag region in the app. Traffic lights sit at x:12 in the
 * first 80px, so that area stays empty. Nothing in here is clickable; never put .drag on
 * anything larger — Electron swallows clicks over drag regions, even under modals.
 */
function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
      const k = e.key.toLowerCase();
      if (k === 'k' && !e.shiftKey) {
        const s = useAxo.getState();
        if (s.ui.newAgent || s.ui.addProject) return;
        e.preventDefault();
        s.setUi({ palette: !s.ui.palette });
        return;
      }
      if (modalOpen()) return;
      if (k === 'n' && !e.shiftKey) { e.preventDefault(); openNewAgent(); }
      else if (k === 'i' && !e.shiftKey) { e.preventDefault(); toggleDrawer(); }
      else if (/^[1-3]$/.test(k)) { e.preventDefault(); focusPaneComposer(Number(k) - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function TitleStrip() {
  const crumbs = useAxo((s) => {
    const sel = focusedSel(s);
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
  const setUi = useAxo((s) => s.setUi);
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t border-border-subtle bg-panel px-3 text-2xs text-muted">
      {order.map((k) => (
        <span key={k} className="flex items-center gap-1.5" title={nodes[k].error ?? nodes[k].status}>
          <ConnDot status={nodes[k].status} /> {nodes[k].name}
          {nodes[k].version && <span className="text-faint">v{nodes[k].version}</span>}
        </span>
      ))}
      <button
        className="flex items-center gap-1 rounded px-1 hover:bg-hover hover:text-secondary cursor-pointer"
        title="Command palette (⌘K)"
        onClick={() => setUi({ palette: true })}
      >
        <Search size={10} /> ⌘K
      </button>
      <span className="ml-auto">{working} working · {all.length} agents</span>
      <span title="Tokens processed across current sessions">{formatTokens(tokens)} tok</span>
      <ThemeToggle />
    </div>
  );
}
