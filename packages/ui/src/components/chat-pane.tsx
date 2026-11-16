import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, MoreHorizontal, Power, Square, Trash2 } from 'lucide-react';
import type { Agent } from '@axo/protocol';
import { feedKey, useAgent, useAxo, type Selection } from '../stores/store.ts';
import { Feed } from './feed/feed.tsx';
import { cn, formatTokens, IconButton, STATUS_LABEL, StatusDot } from './ui.tsx';

export function ChatPane({ sel }: { sel: Selection }) {
  const agent = useAgent(sel);
  const feed = useAxo((s) => s.feeds[feedKey(sel.nodeKey, sel.agentId)]);
  const loadFeed = useAxo((s) => s.loadFeed);
  const nodeName = useAxo((s) => s.nodes[sel.nodeKey]?.name);
  const project = useAxo((s) => s.nodes[sel.nodeKey]?.projects.find((p) => p.id === agent?.projectId));

  if (!agent) return <Empty text="This agent no longer exists." />;
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-surface-2">
      <Header agent={agent} sel={sel} subtitle={`${nodeName} / ${project?.name ?? ''}`} />
      {feed ? (
        <Feed feed={feed} agent={agent} onLoadOlder={() => void loadFeed(sel.nodeKey, sel.agentId, true)} />
      ) : (
        <div className="flex-1" />
      )}
      <Composer agent={agent} sel={sel} />
    </div>
  );
}

function Header({ agent, sel, subtitle }: { agent: Agent; sel: Selection; subtitle: string }) {
  const client = useAxo((s) => s.client);
  const [menu, setMenu] = useState(false);
  const pct = agent.contextWindow ? Math.min(100, Math.round((agent.contextTokens / agent.contextWindow) * 100)) : 0;
  const pctColor = pct >= 80 ? 'bg-danger' : pct >= 60 ? 'bg-warning' : 'bg-accent';

  const act = async (fn: () => Promise<unknown>) => { setMenu(false); try { await fn(); } catch (e: any) { alert(e.message); } };

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border-subtle px-4">
      <StatusDot status={agent.status} />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-semibold text-text-0">{agent.name}</span>
          <span className="text-xs text-text-3">{agent.role}</span>
          <span className={cn('text-2xs', agent.status === 'error' ? 'text-danger' : 'text-text-4')}>{STATUS_LABEL[agent.status]}</span>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-4 text-2xs text-text-3">
        <span className="hidden truncate md:inline">{subtitle}</span>
        <span className="font-mono">{agent.model}</span>
        <span className="flex items-center gap-1.5 font-mono" title={`${agent.contextTokens.toLocaleString()} / ${agent.contextWindow.toLocaleString()} context tokens · ${agent.compactions} compactions`}>
          <span className="h-1 w-12 overflow-hidden rounded-full bg-surface-5">
            <span className={cn('block h-full rounded-full', pctColor)} style={{ width: `${pct}%` }} />
          </span>
          {pct}%
        </span>
        <span className="font-mono" title="Tokens processed this session">{formatTokens(agent.sessionTokens)} tok</span>
        <div className="relative">
          <IconButton title="Agent actions" onClick={() => setMenu(!menu)}><MoreHorizontal size={14} /></IconButton>
          {menu && (
            <div className="absolute right-0 top-7 z-20 w-48 rounded-md border border-border bg-surface-4 py-1 shadow-xl" onMouseLeave={() => setMenu(false)}>
              <MenuItem icon={Power} onClick={() => act(() => client(sel.nodeKey).post(`/agents/${agent.id}/stop`))}>Stop process</MenuItem>
              <MenuItem icon={Trash2} danger onClick={() => {
                if (confirm(`Delete agent ${agent.name}? Its chat history will be removed.`)) void act(() => client(sel.nodeKey).del(`/agents/${agent.id}`));
              }}>Delete agent</MenuItem>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MenuItem({ icon: Icon, children, onClick, danger }: { icon: typeof Power; children: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-6 cursor-pointer', danger ? 'text-danger' : 'text-text-1')}>
      <Icon size={13} /> {children}
    </button>
  );
}

function Composer({ agent, sel }: { agent: Agent; sel: Selection }) {
  const client = useAxo((s) => s.client);
  const key = `axo.draft.${sel.nodeKey}.${sel.agentId}`;
  const [text, setText] = useState(() => localStorage.getItem(key) ?? '');
  const [error, setError] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const working = agent.status === 'working' || agent.status === 'starting';

  useEffect(() => { setText(localStorage.getItem(key) ?? ''); ta.current?.focus(); }, [key]);
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
        <div className="rounded-lg border border-border bg-surface-3 focus-within:border-accent/60">
          <textarea
            ref={ta}
            value={text}
            onChange={(e) => update(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            placeholder={working ? 'Queue a message (delivered when this turn ends) · Esc to interrupt' : `Message ${agent.name}…`}
            className="block max-h-72 w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1 text-[13.5px] leading-relaxed text-text-0 placeholder:text-text-4 outline-none"
          />
          <div className="flex items-center gap-2 px-2 pb-2">
            <span className="pl-1.5 text-2xs text-text-4">
              {agent.queued > 0 ? `${agent.queued} queued` : working ? 'working…' : 'Enter to send · Shift+Enter for newline'}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              {working && (
                <button
                  title="Interrupt (Esc)"
                  onClick={() => void client(sel.nodeKey).post(`/agents/${agent.id}/interrupt`)}
                  className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-5 text-text-1 hover:bg-danger/25 hover:text-danger cursor-pointer"
                >
                  <Square size={11} fill="currentColor" />
                </button>
              )}
              <button
                title="Send (Enter)"
                disabled={!text.trim()}
                onClick={() => void send()}
                className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-surface-0 hover:bg-accent/85 disabled:bg-surface-5 disabled:text-text-4 cursor-pointer"
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
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 bg-surface-2 text-[13px] text-text-3">
      <span>{text}</span>
      {children}
    </div>
  );
}
