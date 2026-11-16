import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, Info, OctagonAlert } from 'lucide-react';
import type { Agent, FeedItem } from '@axo/protocol';
import type { FeedState } from '../../stores/store.ts';
import { ToolGroup, useTick } from './tool-group.tsx';
import { cn, formatDuration } from '../ui.tsx';

type ToolItem = Extract<FeedItem, { kind: 'tool' }>;
type Block =
  | { type: 'item'; item: FeedItem }
  | { type: 'tools'; id: string; items: ToolItem[] }
  | { type: 'draft'; id: string; text: string };

function toBlocks(items: FeedItem[], drafts: Record<string, string>): Block[] {
  const out: Block[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.kind === 'tool') {
      if (last?.type === 'tools') last.items.push(item);
      else out.push({ type: 'tools', id: `g-${item.id}`, items: [item] });
    } else {
      out.push({ type: 'item', item });
    }
  }
  for (const [id, text] of Object.entries(drafts)) out.push({ type: 'draft', id, text });
  return out;
}

export function Feed({ feed, agent, onLoadOlder }: { feed: FeedState; agent: Agent; onLoadOlder: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const blocks = useMemo(() => toBlocks(feed.items, feed.drafts), [feed.items, feed.drafts]);
  const working = agent.status === 'working' || agent.status === 'starting';

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [blocks, stick]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
    if (el.scrollTop < 40 && feed.hasMore) onLoadOlder();
  };

  return (
    <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-5">
        {feed.hasMore && <div className="mb-3 text-center text-2xs text-text-4">Scroll up for earlier messages</div>}
        {!feed.loaded && <div className="py-10 text-center text-xs text-text-3">Loading…</div>}
        {feed.loaded && blocks.length === 0 && (
          <div className="py-16 text-center text-[13px] text-text-3">
            <div className="mb-1 text-text-1">{agent.name} is ready.</div>
            Send the first instruction below.
          </div>
        )}
        {blocks.map((b, i) => <BlockView key={b.type === 'item' ? b.item.id : b.id} block={b} live={working && i >= blocks.length - 2} />)}
        {working && <Working agent={agent} lastBlock={blocks.at(-1)} />}
      </div>
    </div>
  );
}

const BlockView = memo(function BlockView({ block, live }: { block: Block; live: boolean }) {
  if (block.type === 'tools') return <ToolGroup items={block.items} live={live} />;
  if (block.type === 'draft') return <Prose text={block.text} />;
  const item = block.item;
  switch (item.kind) {
    case 'user': return <UserMessage item={item} />;
    case 'text': return <Prose text={item.text} />;
    case 'system': return <SystemLine item={item} />;
    case 'turn': return <TurnFooter item={item} />;
    default: return null;
  }
});

function UserMessage({ item }: { item: Extract<FeedItem, { kind: 'user' }> }) {
  const fromUser = item.author === 'user';
  return (
    <div className={cn('animate-fade-in my-4 flex', fromUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3.5 py-2 text-[13px] leading-relaxed',
          fromUser ? 'bg-surface-5 text-text-0' : 'border border-indigo/40 bg-indigo/8 text-text-1',
        )}
      >
        {!fromUser && <div className="mb-0.5 text-2xs font-medium text-indigo">{item.author}</div>}
        {item.text}
      </div>
    </div>
  );
}

const Prose = memo(function Prose({ text }: { text: string }) {
  return (
    <div className="md my-2 text-[13.5px]">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});

function SystemLine({ item }: { item: Extract<FeedItem, { kind: 'system' }> }) {
  const Icon = item.level === 'error' ? OctagonAlert : item.level === 'warn' ? AlertTriangle : Info;
  return (
    <div
      className={cn(
        'my-2 flex gap-2 rounded-md px-3 py-1.5 text-xs',
        item.level === 'error' && 'bg-danger/10 text-danger',
        item.level === 'warn' && 'bg-warning/10 text-warning',
        item.level === 'info' && 'text-text-3',
      )}
    >
      <Icon size={13} className="mt-0.5 shrink-0" />
      <span className="whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed">{item.text}</span>
    </div>
  );
}

function TurnFooter({ item }: { item: Extract<FeedItem, { kind: 'turn' }> }) {
  return (
    <div className="mb-4 mt-1 flex items-center gap-2 text-2xs text-text-4">
      <span>{formatDuration(item.durationMs)}</span>
      {item.costUsd > 0 && <span>· ${item.costUsd.toFixed(2)}</span>}
      {item.interrupted && <span className="text-warning">· interrupted</span>}
      {item.isError && <span className="text-danger">· ended with error</span>}
    </div>
  );
}

function Working({ agent, lastBlock }: { agent: Agent; lastBlock: Block | undefined }) {
  useTick(true);
  const elapsed = Date.now() - agent.lastActiveAt;
  if (lastBlock?.type === 'draft') return null;
  const toolsRunning = lastBlock?.type === 'tools' && lastBlock.items.some((t) => t.status === 'running');
  if (toolsRunning) return null;
  return (
    <div className="my-2 flex items-center gap-2 text-xs text-text-3">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1 w-1 rounded-full bg-accent animate-pulse-dot" style={{ animationDelay: `${i * 0.2}s` }} />
        ))}
      </span>
      {agent.status === 'starting' ? 'Starting…' : 'Thinking…'}
      {elapsed > 3000 && <span className="text-text-4">{formatDuration(Math.round(elapsed / 1000) * 1000)}</span>}
    </div>
  );
}
