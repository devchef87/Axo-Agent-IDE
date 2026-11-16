import { useEffect, useMemo, useRef, useState } from 'react';
import { Ban, CheckCircle2, Clock, Eye, Loader2, RotateCcw, XCircle } from 'lucide-react';
import type { Watch } from '@axo/protocol';
import { useAxo } from '../../stores/store.ts';
import { useWatchStore, watchRows } from '../../stores/watches.ts';
import { formatAgo } from '../../lib/agent-form.ts';
import { Button, cn, formatDuration } from '../ui.tsx';

type Filter = 'active' | 'finished' | 'all';

export function WatchesView() {
  const byNode = useWatchStore((s) => s.byNode);
  const rows = useMemo(() => watchRows(byNode), [byNode]);
  const nodes = useAxo((s) => s.nodes);
  const multiNode = useAxo((s) => s.nodeOrder.length > 1);
  const [filter, setFilter] = useState<Filter>('active');
  const [sel, setSel] = useState<string | null>(null);

  const active = rows.filter((r) => r.watch.status === 'active');
  const shown = filter === 'all' ? rows : filter === 'active' ? active : rows.filter((r) => r.watch.status !== 'active');
  const selected = rows.find((r) => `${r.nodeKey}:${r.watch.id}` === sel) ?? null;

  // If nothing is running, show recent ones rather than an empty list.
  const initial = useRef(true);
  useEffect(() => {
    if (initial.current && rows.length) { initial.current = false; if (!active.length) setFilter('all'); }
  }, [rows.length, active.length]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border-subtle px-4" role="tablist" aria-label="Filter watches">
        {(['active', 'finished', 'all'] as Filter[]).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
            className={cn('rounded px-2 py-0.5 text-xs capitalize cursor-pointer', filter === f ? 'bg-control text-primary' : 'text-muted hover:text-secondary')}>
            {f}{f === 'active' && active.length > 0 && <span className="ml-1 text-working">{active.length}</span>}
          </button>
        ))}
        <span className="ml-auto text-2xs text-faint">Agents start watches with <code className="font-mono">axo watch</code>; they're woken with the result.</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          {shown.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-xs text-faint">
              <Eye size={18} className="mb-1" />
              {filter === 'active' ? 'No watches running.' : 'No watches yet.'}
            </div>
          ) : (
            <ul role="listbox" aria-label="Watches" className="divide-y divide-border-subtle">
              {shown.map(({ nodeKey, watch: w }) => {
                const key = `${nodeKey}:${w.id}`;
                return (
                  <li key={key}>
                    <button role="option" aria-selected={sel === key} onClick={() => setSel(sel === key ? null : key)}
                      className={cn('flex w-full items-center gap-3 px-4 py-2 text-left cursor-pointer', sel === key ? 'bg-accent/10' : 'hover:bg-hover')}>
                      <WatchIcon w={w} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-primary">{w.label || w.command || w.until}</span>
                        <span className="block truncate font-mono text-2xs text-faint">{w.mode === 'until' ? `until ${w.until}` : w.command}</span>
                      </span>
                      <span className="shrink-0 text-right text-2xs text-muted">
                        <span className="block">{w.agentName ?? 'team setup'}{multiNode ? ` · ${nodes[nodeKey]?.name}` : ''}</span>
                        <span className="block text-faint"><Elapsed w={w} /></span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {selected && <WatchDetail key={`${selected.nodeKey}:${selected.watch.id}`} nodeKey={selected.nodeKey} watch={selected.watch} />}
      </div>
    </div>
  );
}

function WatchIcon({ w }: { w: Watch }) {
  if (w.status === 'active') return <Loader2 size={14} className="shrink-0 animate-spin text-working" aria-label="running" />;
  if (w.status === 'cancelled') return <Ban size={14} className="shrink-0 text-faint" aria-label="cancelled" />;
  const o = w.result?.outcome;
  if (o === 'success') return <CheckCircle2 size={14} className="shrink-0 text-muted" aria-label="succeeded" />;
  if (o === 'timeout') return <Clock size={14} className="shrink-0 text-warning" aria-label="timed out" />;
  return <XCircle size={14} className="shrink-0 text-danger" aria-label={o ?? w.status} />;
}

function Elapsed({ w }: { w: Watch }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (w.status !== 'active') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [w.status]);
  if (w.status === 'active') return <>running {formatDuration(Math.round((Date.now() - w.createdAt) / 1000) * 1000)}</>;
  const took = w.finishedAt ? formatDuration(Math.round((w.finishedAt - w.createdAt) / 1000) * 1000) : '';
  return <>{formatAgo(w.finishedAt ?? w.createdAt)}{took ? ` · ${took}` : ''}</>;
}

const OUTCOME: Record<string, string> = { success: 'Succeeded', failure: 'Failed', timeout: 'Timed out', error: 'Error' };

function WatchDetail({ nodeKey, watch: w }: { nodeKey: string; watch: Watch }) {
  const client = useAxo((s) => s.client);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  // Live tail: poll while running, fetch once when finished.
  useEffect(() => {
    let live = true;
    const load = () => client(nodeKey).get<{ output: string }>(`/watches/${w.id}/output?bytes=65536`)
      .then((r) => { if (live) setOutput(r.output); }, () => {});
    void load();
    if (w.status !== 'active') return () => { live = false; };
    const t = setInterval(load, 1500);
    return () => { live = false; clearInterval(t); };
  }, [client, nodeKey, w.id, w.status]);

  useEffect(() => {
    const el = pre.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  const act = async (what: 'cancel' | 'rerun') => {
    setBusy(true);
    setError(null);
    try { await client(nodeKey).post(`/watches/${w.id}/${what}`); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <aside className="flex w-[46%] min-w-80 shrink-0 flex-col border-l border-border-subtle bg-panel" aria-label="Watch details">
      <div className="shrink-0 border-b border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <WatchIcon w={w} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-primary">{w.label || 'Watch'}</span>
          {w.status === 'active'
            ? <Button size="sm" variant="danger" disabled={busy} onClick={() => void act('cancel')}><Ban size={11} /> Cancel</Button>
            : <Button size="sm" disabled={busy} onClick={() => void act('rerun')} title="Run it again; the agent is woken with the new result"><RotateCcw size={11} /> Rerun</Button>}
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-2xs">
          <dt className="text-faint">{w.mode === 'until' ? 'Until' : 'Command'}</dt><dd className="break-all font-mono text-secondary">{w.mode === 'until' ? w.until : w.command}</dd>
          <dt className="text-faint">Agent</dt><dd className="text-secondary">{w.agentName ?? 'team setup'}</dd>
          <dt className="text-faint">In</dt><dd className="truncate font-mono text-secondary" title={w.cwd}>{w.cwd}</dd>
          <dt className="text-faint">Status</dt>
          <dd className="text-secondary">
            {w.status === 'active' ? <Elapsed w={w} /> : w.result ? `${OUTCOME[w.result.outcome] ?? w.result.outcome}${w.result.exitCode != null ? ` (exit ${w.result.exitCode})` : ''} · ${w.status}` : w.status}
          </dd>
        </dl>
        {w.result?.summary && <p className="mt-2 text-xs text-secondary">{w.result.summary}</p>}
        {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      </div>
      <pre
        ref={pre}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-inset px-4 py-3 font-mono text-2xs leading-relaxed text-secondary"
      >
        {output === null ? 'Loading output…' : output || (w.status === 'active' ? 'No output yet.' : 'No output.')}
      </pre>
    </aside>
  );
}
