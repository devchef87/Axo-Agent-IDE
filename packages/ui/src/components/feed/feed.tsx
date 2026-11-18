import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, ChevronDown, ChevronUp, Info, OctagonAlert } from 'lucide-react';
import type { Agent, FeedItem } from '@axo/protocol';
import type { FeedState } from '../../stores/store.ts';
import { ToolGroup, useTick } from './tool-group.tsx';
import { cn, formatDuration, REFRESH_REASON } from '../ui.tsx';
import { Collapsible } from './collapsible.tsx';
import { FeedContext } from './feed-context.ts';

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

export function Feed({ feed, agent, nodeKey, onLoadOlder }: { feed: FeedState; agent: Agent; nodeKey: string; onLoadOlder: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const blocks = useMemo(() => toBlocks(feed.items, feed.drafts), [feed.items, feed.drafts]);
  const working = agent.status === 'working' || agent.status === 'starting';
  const lastText = blocks.findLastIndex((b) => b.type === 'item' && b.item.kind === 'text');

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

  const ctx = useMemo(() => ({ nodeKey, agentId: agent.id }), [nodeKey, agent.id]);
  return (
    <FeedContext.Provider value={ctx}>
    <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-6 py-6">
        {feed.hasMore && <div className="mb-3 text-center text-2xs text-faint">Scroll up for earlier messages</div>}
        {!feed.loaded && <div className="py-10 text-center text-xs text-faint">Loading…</div>}
        {feed.loaded && blocks.length === 0 && (
          <div className="py-16 text-center text-[13px] text-faint">
            <div className="mb-1 text-secondary">{agent.name} is ready.</div>
            Send the first instruction below.
          </div>
        )}
        {blocks.map((b, i) => <BlockView key={b.type === 'item' ? b.item.id : b.id} block={b} live={working && i >= blocks.length - 2} latest={i === lastText} />)}
        {working && <Working agent={agent} lastBlock={blocks.at(-1)} />}
      </div>
    </div>
    </FeedContext.Provider>
  );
}

const BlockView = memo(function BlockView({ block, live, latest }: { block: Block; live: boolean; latest: boolean }) {
  if (block.type === 'tools') return <ToolGroup items={block.items} live={live} />;
  if (block.type === 'draft') return <Prose text={block.text} />;
  const item = block.item;
  switch (item.kind) {
    case 'user': return <UserMessage item={item} />;
    case 'text': return <FoldedProse text={item.text} startOpen={latest} />;
    case 'system': return <SystemLine item={item} />;
    case 'turn': return <TurnFooter item={item} />;
    case 'rotation': return <RotationDivider item={item} />;
    default: return null;
  }
});

function UserMessage({ item }: { item: Extract<FeedItem, { kind: 'user' }> }) {
  if (item.author === 'user') {
    // Yours: a bubble on the right, so the conversation doesn't read as one wall of text.
    return (
      <div className="animate-fade-in mb-3 mt-6 flex justify-end first:mt-0">
        <div className="max-w-[min(70%,720px)] whitespace-pre-wrap break-words rounded-[8px] rounded-br-[3px] bg-control px-3.5 py-2 text-[13px] leading-relaxed text-primary">
          <Collapsible as="div" text={item.text} />
        </div>
      </div>
    );
  }
  // From another agent: left, with its name and a rule.
  return (
    <div className="animate-fade-in mb-3 mt-6 first:mt-0">
      <div className="label mb-1">{item.author}</div>
      <div className="whitespace-pre-wrap break-words border-l border-border-strong pl-3 text-[13px] leading-relaxed text-secondary">
        <Collapsible as="div" text={item.text} />
      </div>
    </div>
  );
}

const FOLD_OVER = 440;   // px of rendered reply before it folds
const FOLDED_TO = 260;

/**
 * A finished reply. Long ones fold to their first ~260px with a fade and Show more / Show less,
 * measured on the rendered markdown so code blocks and tables aren't cut mid-structure.
 * The latest reply starts open; older long replies start folded.
 */
function FoldedProse({ text, startOpen }: { text: string; startOpen: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(startOpen);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setTall(el.scrollHeight > FOLD_OVER);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const folded = tall && !open;
  const toggle = () => {
    setOpen(!open);
    // Collapsing a long reply from below: keep its top in view instead of jumping past it.
    if (open) requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'nearest' }));
  };
  return (
    <div className="relative">
      <div ref={ref} style={folded ? { maxHeight: FOLDED_TO, overflow: 'hidden' } : undefined} className="md my-2 text-[13.5px]">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
      {folded && <div className="pointer-events-none absolute inset-x-0 bottom-7 h-16 bg-gradient-to-t from-[var(--bg)] to-transparent" aria-hidden />}
      {tall && (
        <button onClick={toggle} aria-expanded={open}
          className="mb-1 flex h-6 items-center gap-1 rounded-[4px] border border-border px-2 text-2xs text-secondary hover:bg-hover hover:text-primary cursor-pointer">
          {open ? <><ChevronUp size={11} /> Show less</> : <><ChevronDown size={11} /> Show more</>}
        </button>
      )}
    </div>
  );
}

export const Prose = memo(function Prose({ text }: { text: string }) {
  return (
    <div className="md my-2 text-[13.5px]">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});

/** Context refresh. Deliberately quiet: rotations should feel invisible. */
function RotationDivider({ item }: { item: Extract<FeedItem, { kind: 'rotation' }> }) {
  const why = REFRESH_REASON[item.reason] ?? item.reason;
  const title = [`Context refreshed (${why})`, item.note].filter(Boolean).join('\n\n');
  return (
    <div className="my-5 flex items-center gap-3 text-2xs text-faint" title={title}>
      <span className="h-px flex-1 bg-border-subtle" />
      <span className="cursor-default select-none">context refreshed · gen {item.generation}</span>
      <span className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}

function SystemLine({ item }: { item: Extract<FeedItem, { kind: 'system' }> }) {
  const Icon = item.level === 'error' ? OctagonAlert : item.level === 'warn' ? AlertTriangle : Info;
  return (
    <div
      className={cn(
        'my-2 flex gap-2 border-l px-3 py-1 text-xs',
        item.level === 'error' && 'border-danger text-danger',
        item.level === 'warn' && 'border-warning text-warning',
        item.level === 'info' && 'border-transparent',
        item.level === 'info' && 'text-faint',
      )}
    >
      <Icon size={13} className="mt-0.5 shrink-0" />
      <span className="whitespace-pre-wrap break-words text-xs leading-relaxed">{item.text}</span>
    </div>
  );
}

function TurnFooter({ item }: { item: Extract<FeedItem, { kind: 'turn' }> }) {
  return (
    <div className="mb-4 mt-1.5 flex items-center gap-2 font-mono text-2xs text-faint">
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
    <div className="my-2 flex items-center gap-2 text-xs text-faint">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1 w-1 rounded-full bg-working animate-pulse-dot" style={{ animationDelay: `${i * 0.2}s` }} />
        ))}
      </span>
      {agent.status === 'starting' ? 'Starting…' : 'Thinking…'}
      {elapsed > 3000 && <span className="text-faint">{formatDuration(Math.round(elapsed / 1000) * 1000)}</span>}
    </div>
  );
}
