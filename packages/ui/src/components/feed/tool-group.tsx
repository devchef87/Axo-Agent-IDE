import { useEffect, useState } from 'react';
import {
  ChevronRight, FileText, FilePen, FilePlus, Search, Terminal, Globe, ListTodo, Bot, Wrench, Loader2, AlertCircle, Check,
} from 'lucide-react';
import type { FeedItem } from '@axo/protocol';
import { cn, formatDuration } from '../ui.tsx';

type ToolItem = Extract<FeedItem, { kind: 'tool' }>;

const ICONS: Record<string, typeof Wrench> = {
  Bash: Terminal, Read: FileText, Write: FilePlus, Edit: FilePen, MultiEdit: FilePen, NotebookEdit: FilePen,
  Glob: Search, Grep: Search, WebFetch: Globe, WebSearch: Globe, TodoWrite: ListTodo, Task: Bot, Agent: Bot,
};
const VERB: Record<string, string> = {
  Bash: 'Ran', Read: 'Read', Write: 'Wrote', Edit: 'Edited', MultiEdit: 'Edited', Glob: 'Searched', Grep: 'Searched',
  WebFetch: 'Fetched', WebSearch: 'Searched web', TodoWrite: 'Updated todos', Task: 'Delegated', Agent: 'Delegated',
};

/** Consecutive tool calls, collapsed. While live, shows the current call; when done, "N tool calls". */
export function ToolGroup({ items, live }: { items: ToolItem[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const running = items.filter((t) => t.status === 'running');
  const errors = items.filter((t) => t.status === 'error').length;
  const current = running.at(-1) ?? items.at(-1)!;
  const showLive = live && running.length > 0;

  return (
    <div className="my-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="group flex max-w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-text-3 hover:bg-surface-3 hover:text-text-1 cursor-pointer"
      >
        <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
        {showLive ? (
          <>
            <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
            <span className="shrink-0 text-text-2">{current.tool}</span>
            <span className="truncate font-mono text-2xs text-text-3">{current.summary}</span>
          </>
        ) : (
          <>
            <span>{items.length === 1 ? `${VERB[current.tool] ?? current.tool}` : `${items.length} tool calls`}</span>
            {items.length === 1 && <span className="truncate font-mono text-2xs">{current.summary}</span>}
            {errors > 0 && <span className="shrink-0 text-danger">· {errors} failed</span>}
          </>
        )}
      </button>
      {open && (
        <div className="ml-4 mt-0.5 border-l border-border-subtle pl-2">
          {items.map((t) => <ToolRow key={t.id} item={t} />)}
        </div>
      )}
    </div>
  );
}

function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[item.tool] ?? Wrench;
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs hover:bg-surface-3 cursor-pointer">
        <Icon size={12} className="shrink-0 text-text-3" />
        <span className="shrink-0 text-text-2">{item.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-text-3">{item.summary}</span>
        {item.durationMs != null && item.durationMs > 1500 && <span className="shrink-0 text-2xs text-text-4">{formatDuration(item.durationMs)}</span>}
        {item.status === 'running' && <Loader2 size={11} className="shrink-0 animate-spin text-accent" />}
        {item.status === 'error' && <AlertCircle size={11} className="shrink-0 text-danger" />}
        {item.status === 'ok' && <Check size={11} className="shrink-0 text-text-4" />}
      </button>
      {open && <ToolDetail item={item} />}
    </div>
  );
}

function ToolDetail({ item }: { item: ToolItem }) {
  const i = item.input as Record<string, any>;
  return (
    <div className="mb-2 ml-5 mt-1 space-y-1.5">
      {item.tool === 'Bash' && <Pre>{`$ ${i.command}`}</Pre>}
      {(item.tool === 'Edit') && typeof i.old_string === 'string' && <Diff before={i.old_string} after={i.new_string ?? ''} />}
      {item.tool === 'MultiEdit' && Array.isArray(i.edits) && i.edits.map((e: any, n: number) => <Diff key={n} before={e.old_string} after={e.new_string} />)}
      {item.tool === 'Write' && typeof i.content === 'string' && <Pre>{i.content}</Pre>}
      {!['Bash', 'Edit', 'MultiEdit', 'Write'].includes(item.tool) && <Pre>{JSON.stringify(i, null, 2)}</Pre>}
      {item.result && item.tool !== 'Read' && (
        <Pre className={item.status === 'error' ? 'border-danger/40 text-danger' : undefined}>{item.result}</Pre>
      )}
    </div>
  );
}

function Pre({ children, className }: { children: string; className?: string }) {
  return (
    <pre className={cn('max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border border-border-subtle bg-surface-0 px-2.5 py-1.5 font-mono text-2xs leading-relaxed text-text-2', className)}>
      {children}
    </pre>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="max-h-72 overflow-auto rounded border border-border-subtle bg-surface-0 py-1.5 font-mono text-2xs leading-relaxed">
      {before.split('\n').map((l, n) => <div key={`b${n}`} className="bg-danger/10 px-2.5 text-danger/90 whitespace-pre-wrap break-all">- {l}</div>)}
      {after.split('\n').map((l, n) => <div key={`a${n}`} className="bg-success/10 px-2.5 text-success/90 whitespace-pre-wrap break-all">+ {l}</div>)}
    </pre>
  );
}

/** Re-render periodically while something is live (for elapsed timers). */
export function useTick(active: boolean, ms = 1000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return n;
}
