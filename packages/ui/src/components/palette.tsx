import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { BookOpen, Code2, FileSearch, Users, Columns2, FolderOpen, FolderPlus, GitFork, Monitor, Moon, PanelRight, Plus, RefreshCw, Bell, BellOff, Search, Server, Sun, X, type LucideIcon } from 'lucide-react';
import type { AgentStatus } from '@axo/protocol';
import { focusedSel, useAxo } from '../stores/store.ts';
import { useTheme, type ThemePref } from '../lib/theme.ts';
import { fuzzyFilter } from '../lib/fuzzy.ts';
import { openNewAgent, openQuickOpen, toggleDrawer, toggleView } from '../lib/actions.ts';
import { isElectron } from '../lib/bridge.ts';
import { notificationsEnabled, setNotificationsEnabled } from '../lib/notifications.ts';
import { cn, Kbd, StatusDot, useModalFocus } from './ui.tsx';

interface Command {
  id: string;
  group: 'Agents' | 'Projects' | 'Actions';
  label: string;
  detail?: string;
  icon?: LucideIcon;
  status?: AgentStatus;
  shortcut?: string;
  /** `alt` = ⌘Enter (agents: open in a split). */
  run(alt: boolean): void;
}

const THEME_ICON: Record<ThemePref, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };

function useCommands(open: boolean): Command[] {
  const nodes = useAxo((s) => s.nodes);
  const order = useAxo((s) => s.nodeOrder);
  const layout = useAxo((s) => s.layout);
  const pref = useTheme((s) => s.pref);

  return useMemo(() => {
    if (!open) return [];
    const s = useAxo.getState();
    const multiNode = order.length > 1;
    const out: Command[] = [];

    const agents = order.flatMap((k) => nodes[k].agents.map((a) => ({ k, a })))
      .sort((x, y) => y.a.lastActiveAt - x.a.lastActiveAt);
    for (const { k, a } of agents) {
      const project = nodes[k].projects.find((p) => p.id === a.projectId)?.name ?? '';
      out.push({
        id: `agent:${k}:${a.id}`, group: 'Agents', label: a.name, status: a.status,
        detail: [multiNode ? nodes[k].name : null, project, a.role].filter(Boolean).join(' · '),
        run: (alt) => (alt ? s.openInSplit : s.select)({ nodeKey: k, agentId: a.id }),
      });
    }

    for (const k of order) {
      for (const p of nodes[k].projects) {
        const where = multiNode ? `${nodes[k].name} · ${p.path}` : p.path;
        const latest = nodes[k].agents.filter((a) => a.projectId === p.id).sort((x, y) => y.lastActiveAt - x.lastActiveAt)[0];
        out.push({
          id: `project:${k}:${p.id}`, group: 'Projects', label: p.name, detail: latest ? `${where} · opens ${latest.name}` : where, icon: FolderOpen,
          run: (alt) => {
            if (!latest) return s.setUi({ newAgent: { nodeKey: k, projectId: p.id } });
            (alt ? s.openInSplit : s.select)({ nodeKey: k, agentId: latest.id });
          },
        });
        out.push({
          id: `new-in:${k}:${p.id}`, group: 'Actions', label: `New agent in ${p.name}`, detail: multiNode ? nodes[k].name : undefined, icon: Plus,
          run: () => s.setUi({ newAgent: { nodeKey: k, projectId: p.id } }),
        });
      }
      for (const p of nodes[k].projects) {
        out.push({
          id: `context:${k}:${p.id}`, group: 'Actions', label: `Project map & decisions: ${p.name}`, detail: multiNode ? nodes[k].name : undefined, icon: BookOpen,
          run: () => s.setUi({ context: { nodeKey: k, projectId: p.id } }),
        });
      }
      out.push({ id: `add-project:${k}`, group: 'Actions', label: `Add project on ${nodes[k].name}`, icon: FolderPlus, run: () => s.setUi({ addProject: k }) });
    }

    out.unshift(s.view === 'editor'
      ? { id: 'view', group: 'Actions', label: 'Back to Fleet', icon: Users, shortcut: '⌘E', run: () => toggleView() }
      : { id: 'view', group: 'Actions', label: 'Open editor', icon: Code2, shortcut: '⌘E', run: () => toggleView() });
    out.splice(1, 0, { id: 'go-to-file', group: 'Actions', label: 'Go to file…', icon: FileSearch, shortcut: '⌘P', run: () => openQuickOpen() });
    out.unshift({ id: 'new-agent', group: 'Actions', label: 'New agent…', icon: Plus, shortcut: '⌘N', run: () => openNewAgent() });
    const next: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
    out.push({
      id: 'theme', group: 'Actions', label: `Toggle theme (now ${pref})`, detail: `Switch to ${next[pref]}`, icon: THEME_ICON[next[pref]],
      run: () => useTheme.getState().setPref(next[pref]),
    });
    for (const p of ['system', 'light', 'dark'] as ThemePref[]) {
      if (p !== pref) out.push({ id: `theme:${p}`, group: 'Actions', label: `Theme: ${p[0].toUpperCase()}${p.slice(1)}`, icon: THEME_ICON[p], run: () => useTheme.getState().setPref(p) });
    }
    if (isElectron) {
      const on = notificationsEnabled();
      out.push({ id: 'notifications', group: 'Actions', label: on ? 'Turn notifications off' : 'Turn notifications on', detail: 'Agent finished / asked a question, watch done, refresh aborted, server disconnected', icon: on ? BellOff : Bell, run: () => setNotificationsEnabled(!on) });
    }
    if (isElectron) out.push({ id: 'servers', group: 'Actions', label: 'Servers…', detail: 'Add, deploy and connect remote servers', icon: Server, run: () => s.setUi({ servers: true }) });
    const f = focusedSel(s);
    const fa = f ? nodes[f.nodeKey]?.agents.find((a) => a.id === f.agentId) : undefined;
    if (f && fa) {
      out.push({ id: 'drawer', group: 'Actions', label: 'Agent settings', icon: PanelRight, shortcut: '⌘I', run: () => toggleDrawer() });
      out.push({ id: 'refresh', group: 'Actions', label: `Refresh ${fa.name}'s context…`, icon: RefreshCw, run: () => s.setUi({ refresh: f }) });
      out.push({ id: 'fork', group: 'Actions', label: `Fork ${fa.name}…`, icon: GitFork, run: () => s.setUi({ fork: f }) });
    }
    if (layout.panes.length > 1) {
      out.push({ id: 'close-pane', group: 'Actions', label: 'Close pane', icon: X, run: () => s.closePane(layout.focused) });
      out.push({ id: 'reset-panes', group: 'Actions', label: 'Reset pane sizes', icon: Columns2, run: () => s.resetPaneSizes() });
    }
    return out;
  }, [open, nodes, order, layout, pref]);
}

const GROUP_ORDER: Command['group'][] = ['Agents', 'Projects', 'Actions'];

export function CommandPalette() {
  const open = useAxo((s) => s.ui.palette);
  const setUi = useAxo((s) => s.setUi);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = () => setUi({ palette: false });
  useModalFocus(panel, open, close);
  const commands = useCommands(open);

  const results = useMemo(() => {
    if (!query.trim()) {
      // No query: a short, useful default rather than everything.
      const by = (g: Command['group'], n: number) => commands.filter((c) => c.group === g).slice(0, n);
      return [...by('Agents', 8), ...commands.filter((c) => c.group === 'Actions' && !c.id.startsWith('new-in:') && !c.id.startsWith('add-project:') && !c.id.startsWith('theme:') && !c.id.startsWith('context:'))];
    }
    const ranked = fuzzyFilter(commands, query, (c) => `${c.label} ${c.detail ?? ''}`);
    // Keep the ranking but group by kind, so the list doesn't jump between kinds.
    return GROUP_ORDER.flatMap((g) => ranked.filter((c) => c.group === g)).slice(0, 60);
  }, [commands, query]);

  useEffect(() => { if (open) { setQuery(''); setActive(0); } }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const run = (c: Command | undefined, alt: boolean) => {
    if (!c) return;
    close();
    c.run(alt);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(results[active], e.metaKey || e.ctrlKey); }
  };

  let lastGroup = '';
  return (
    <div className="no-drag fixed inset-0 z-50 flex items-start justify-center bg-[var(--overlay)] pt-[14vh]" onMouseDown={close}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="animate-fade-in flex max-h-[60vh] w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-border bg-elevated shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border-subtle px-3">
          <Search size={14} className="shrink-0 text-faint" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Jump to an agent or project, or run a command…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[active] ? `palette-${active}` : undefined}
            className="h-11 flex-1 bg-transparent text-[13.5px] text-primary placeholder:text-faint outline-none"
          />
        </div>
        <div ref={list} id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
          {results.length === 0 && <p className="px-4 py-6 text-center text-xs text-faint">No matches</p>}
          {results.map((c, i) => {
            const header = c.group !== lastGroup ? (lastGroup = c.group) : null;
            const Icon = c.icon;
            return (
              <div key={c.id}>
                {header && <div className="px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wide text-faint">{header}</div>}
                <div
                  id={`palette-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => { if (i !== active) setActive(i); }}
                  onClick={(e) => run(c, e.metaKey || e.ctrlKey)}
                  className={cn('mx-1 flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px]',
                    i === active ? 'bg-control text-primary' : 'text-secondary')}
                >
                  {c.status ? <StatusDot status={c.status} className="mx-[3px]" /> : Icon ? <Icon size={14} className="shrink-0 text-muted" /> : null}
                  <span className="shrink-0 truncate">{c.label}</span>
                  {c.detail && <span className="min-w-0 truncate text-xs text-faint">{c.detail}</span>}
                  {c.shortcut && <span className="ml-auto shrink-0"><Kbd>{c.shortcut}</Kbd></span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 border-t border-border-subtle px-3 py-1.5 text-2xs text-faint">
          <span><Kbd>↑↓</Kbd> navigate</span>
          <span><Kbd>↵</Kbd> open</span>
          <span><Kbd>⌘↵</Kbd> open in split</span>
          <span className="ml-auto"><Kbd>esc</Kbd> close</span>
        </div>
      </div>
    </div>
  );
}
