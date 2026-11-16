import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, GitFork, MoreHorizontal, PanelRight, Power, RefreshCw, Square, Trash2, X } from 'lucide-react';
import type { Agent } from '@axo/protocol';
import { feedKey, useAgent, useAxo, useRefreshing, type Selection } from '../stores/store.ts';
import { Feed } from './feed/feed.tsx';
import { cn, formatTokens, IconButton, STATUS_LABEL, StatusDot, useDismiss } from './ui.tsx';
import { formatUsd, totalTokens, useAgentToday } from '../stores/usage.ts';

export function ChatPane({ sel, index = 0, focused = true, multi = false }: { sel: Selection; index?: number; focused?: boolean; multi?: boolean }) {
  const agent = useAgent(sel);
  const feed = useAxo((s) => s.feeds[feedKey(sel.nodeKey, sel.agentId)]);
  const loadFeed = useAxo((s) => s.loadFeed);
  const nodeName = useAxo((s) => s.nodes[sel.nodeKey]?.name);
  const project = useAxo((s) => s.nodes[sel.nodeKey]?.projects.find((p) => p.id === agent?.projectId));

  const closePane = useAxo((s) => s.closePane);

  if (!agent) {
    return (
      <Empty text="This agent no longer exists.">
        {multi && <button className="text-xs text-muted underline hover:text-primary cursor-pointer" onClick={() => closePane(index)}>Close pane</button>}
      </Empty>
    );
  }
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-bg">
      <Header agent={agent} sel={sel} subtitle={`${nodeName} / ${project?.name ?? ''}`} index={index} focused={focused} multi={multi} />
      <UsageStrip agent={agent} nodeKey={sel.nodeKey} />
      {feed ? (
        <Feed feed={feed} agent={agent} nodeKey={sel.nodeKey} onLoadOlder={() => void loadFeed(sel.nodeKey, sel.agentId, true)} />
      ) : (
        <div className="flex-1" />
      )}
      <Composer agent={agent} sel={sel} autoFocus={focused} />
    </div>
  );
}

function Header({ agent, sel, subtitle, index, focused, multi }: { agent: Agent; sel: Selection; subtitle: string; index: number; focused: boolean; multi: boolean }) {
  const client = useAxo((s) => s.client);
  const closePane = useAxo((s) => s.closePane);
  const drawerOpen = useAxo((s) => s.ui.drawer);
  const setUi = useAxo((s) => s.setUi);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const refreshing = useRefreshing(sel);
  useDismiss(menuRef, menu, () => setMenu(false));

  const act = async (fn: () => Promise<unknown>) => { setMenu(false); try { await fn(); } catch (e: any) { alert(e.message); } };

  return (
    <div className={cn('flex h-11 shrink-0 items-center gap-3 border-b border-border-subtle px-4',
      multi && focused && 'shadow-[inset_0_2px_0_var(--accent)]')}>
      <StatusDot status={agent.status} />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className={cn('truncate text-[13px] font-semibold', multi && !focused ? 'text-secondary' : 'text-primary')}>{agent.name}</span>
          <span className="hidden text-xs text-faint @md:inline">{agent.role}</span>
          {refreshing ? (
            <span className="flex items-center gap-1 text-2xs text-rotating" title="Preparing a fresh context in the background; the agent keeps working">
              <RefreshCw size={10} className="animate-spin [animation-duration:2s]" /> refreshing…
            </span>
          ) : (
            <span className={cn('text-2xs', agent.status === 'error' ? 'text-danger' : 'text-faint')}>{STATUS_LABEL[agent.status]}</span>
          )}
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-4 text-2xs text-faint">
        <span className="hidden truncate @3xl:inline">{subtitle}</span>
        <span className="hidden font-mono @xl:inline">{agent.model}</span>
        <div className="flex items-center gap-0.5">
        <IconButton
          title="Agent settings (⌘I)"
          aria-pressed={drawerOpen && focused}
          className={cn(drawerOpen && focused && 'bg-control text-primary')}
          onClick={() => setUi({ drawer: !(drawerOpen && focused) })}
        >
          <PanelRight size={14} />
        </IconButton>
        <div ref={menuRef} className="relative">
          <IconButton title="Agent actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={14} /></IconButton>
          {menu && (
            <div role="menu" className="absolute right-0 top-7 z-20 w-48 rounded-md border border-border bg-elevated py-1 shadow-pop">
              <MenuItem icon={RefreshCw} disabled={refreshing} onClick={() => { setMenu(false); setUi({ refresh: sel }); }}>Refresh context…</MenuItem>
              <MenuItem icon={GitFork} onClick={() => { setMenu(false); setUi({ fork: sel }); }}>Fork agent…</MenuItem>
              <div className="my-1 border-t border-border-subtle" />
              <MenuItem icon={Power} onClick={() => act(() => client(sel.nodeKey).post(`/agents/${agent.id}/stop`))}>Stop process</MenuItem>
              <MenuItem icon={Trash2} danger onClick={() => {
                if (confirm(`Delete agent ${agent.name}? Its chat history will be removed.`)) void act(() => client(sel.nodeKey).del(`/agents/${agent.id}`));
              }}>Delete agent</MenuItem>
            </div>
          )}
        </div>
        {multi && <IconButton title="Close pane" onClick={() => closePane(index)}><X size={14} /></IconButton>}
        </div>
      </div>
    </div>
  );
}

/** Context, session and today's usage for one agent, under the pane header. */
function UsageStrip({ agent, nodeKey }: { agent: Agent; nodeKey: string }) {
  const today = useAgentToday(nodeKey, agent.id);
  const pct = agent.contextWindow ? Math.min(100, Math.round((agent.contextTokens / agent.contextWindow) * 100)) : 0;
  const pctCls = pct >= 80 ? 'bg-danger' : pct >= 60 ? 'bg-warning' : 'bg-muted';
  const todayTok = totalTokens(today);
  const cacheHit = today && today.input + today.cacheRead + today.cacheCreation > 0
    ? Math.round((today.cacheRead / (today.input + today.cacheRead + today.cacheCreation)) * 100) : null;
  return (
    <div className="flex h-7 shrink-0 items-center gap-4 overflow-hidden border-b border-border-subtle px-4 text-2xs text-faint" aria-label="Usage">
      <span className="flex shrink-0 items-center gap-1.5"
        title={`${agent.contextTokens.toLocaleString()} of ${agent.contextWindow.toLocaleString()} context tokens${agent.compactions ? ` · ${agent.compactions} compaction${agent.compactions === 1 ? '' : 's'}` : ''}`}>
        <span>Context</span>
        <span className="h-1 w-16 overflow-hidden rounded-full bg-control" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Context used">
          <span className={cn('block h-full rounded-full', pctCls)} style={{ width: `${pct}%` }} />
        </span>
        <span className={cn('font-mono', pct >= 80 ? 'text-danger' : pct >= 60 ? 'text-warning' : 'text-muted')}>{pct}%</span>
        <span className="hidden font-mono @md:inline">{formatTokens(agent.contextTokens)}/{formatTokens(agent.contextWindow)}</span>
      </span>
      <span className="hidden shrink-0 font-mono @lg:inline" title="Tokens processed in the current session">session {formatTokens(agent.sessionTokens)}</span>
      <span className="shrink-0 font-mono" title={today
        ? `Today: ${today.turns} turn${today.turns === 1 ? '' : 's'} · in ${today.input.toLocaleString()} · out ${today.output.toLocaleString()} · cache read ${today.cacheRead.toLocaleString()} · cache write ${today.cacheCreation.toLocaleString()}`
        : 'No turns today'}>
        today <span className="text-muted">{formatUsd(today?.costUsd ?? 0)}</span>
        <span className="hidden @md:inline"> · {formatTokens(todayTok)} tok</span>
        <span className="hidden @xl:inline"> · {today?.turns ?? 0} turn{today?.turns === 1 ? '' : 's'}</span>
      </span>
      {cacheHit !== null && <span className="hidden shrink-0 font-mono @2xl:inline" title="Share of today's input tokens served from the prompt cache">cache {cacheHit}%</span>}
      {agent.compactions > 0 && <span className="hidden shrink-0 @3xl:inline">{agent.compactions} compaction{agent.compactions === 1 ? '' : 's'}</span>}
    </div>
  );
}

function MenuItem({ icon: Icon, children, onClick, danger, disabled }: { icon: typeof Power; children: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button role="menuitem" disabled={disabled} onClick={onClick} className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-hover cursor-pointer disabled:opacity-40 disabled:pointer-events-none', danger ? 'text-danger' : 'text-secondary')}>
      <Icon size={13} /> {children}
    </button>
  );
}

function Composer({ agent, sel, autoFocus }: { agent: Agent; sel: Selection; autoFocus: boolean }) {
  const client = useAxo((s) => s.client);
  const key = `axo.draft.${sel.nodeKey}.${sel.agentId}`;
  const [text, setText] = useState(() => localStorage.getItem(key) ?? '');
  const [error, setError] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const working = agent.status === 'working' || agent.status === 'starting';

  // Focus on open only for the focused pane, so opening several panes doesn't fight over focus.
  useEffect(() => { setText(localStorage.getItem(key) ?? ''); if (autoFocus) ta.current?.focus(); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 280) + 'px';
  }, [text]);

  const update = (v: string) => { setText(v); if (v) localStorage.setItem(key, v); else localStorage.removeItem(key); };

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    update('');
    setError(null);
    try {
      await client(sel.nodeKey).post(`/agents/${agent.id}/message`, { text: t });
    } catch (e: any) {
      update(t);
      setError(e.message);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
    if (e.key === 'Escape' && working) void client(sel.nodeKey).post(`/agents/${agent.id}/interrupt`);
  };

  return (
    <div className="shrink-0 px-6 pb-4">
      <div className="mx-auto max-w-3xl">
        {error && <div className="mb-1.5 text-xs text-danger">{error}</div>}
        <div className="rounded-lg border border-border bg-elevated focus-within:border-accent/60">
          <textarea
            ref={ta}
            value={text}
            onChange={(e) => update(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            placeholder={working ? 'Queue a message (delivered when this turn ends) · Esc to interrupt' : `Message ${agent.name}…`}
            className="block max-h-72 w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1 text-[13.5px] leading-relaxed text-primary placeholder:text-faint outline-none"
          />
          <div className="flex items-center gap-2 px-2 pb-2">
            <span className="pl-1.5 text-2xs text-faint">
              {agent.queued > 0 ? `${agent.queued} queued` : working ? 'working…' : 'Enter to send · Shift+Enter for newline'}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              {working && (
                <button
                  title="Interrupt (Esc)"
                  onClick={() => void client(sel.nodeKey).post(`/agents/${agent.id}/interrupt`)}
                  className="flex h-7 w-7 items-center justify-center rounded-md bg-control text-secondary hover:bg-danger/25 hover:text-danger cursor-pointer"
                >
                  <Square size={11} fill="currentColor" />
                </button>
              )}
              <button
                title="Send (Enter)"
                disabled={!text.trim()}
                onClick={() => void send()}
                className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-accent-fg hover:bg-accent-hover disabled:bg-control disabled:text-faint cursor-pointer"
              >
                <ArrowUp size={14} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Empty({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 bg-bg text-[13px] text-faint">
      <span>{text}</span>
      {children}
    </div>
  );
}
