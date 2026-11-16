import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ProjectContext } from '@axo/protocol';
import { useAxo } from '../stores/store.ts';
import { Prose } from './feed/feed.tsx';
import { Button, cn, Modal } from './ui.tsx';

type Doc = 'map' | 'decisions';
const LABEL: Record<Doc, string> = { map: 'Project map', decisions: 'Decisions' };
const EMPTY: Record<Doc, string> = {
  map: 'No project map yet. The journalist builds one in the background, or use Rebuild map.',
  decisions: 'No decisions logged yet. The journalist records them as agents make them.',
};

/** Journalist-maintained project map and decision log. */
export function ProjectContextDialog() {
  const target = useAxo((s) => s.ui.context);
  const setUi = useAxo((s) => s.setUi);
  const client = useAxo((s) => s.client);
  const project = useAxo((s) => (target ? s.nodes[target.nodeKey]?.projects.find((p) => p.id === target.projectId) : undefined));
  const rev = useAxo((s) => (target ? s.journalRev[`${target.nodeKey}:project:${target.projectId}`] ?? 0 : 0));
  const [tab, setTab] = useState<Doc>('map');
  const [ctx, setCtx] = useState<ProjectContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (target) { setCtx(null); setError(null); setTab('map'); } }, [target?.nodeKey, target?.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!target) return;
    let live = true;
    client(target.nodeKey).get<ProjectContext>(`/projects/${target.projectId}/context`)
      .then((c) => { if (live) { setCtx(c); setError(null); } })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [target?.nodeKey, target?.projectId, rev, client]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => setUi({ context: null });

  const rebuild = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      setCtx(await client(target.nodeKey).post<ProjectContext>(`/projects/${target.projectId}/context/refresh`));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const text = ctx?.[tab] ?? '';

  return (
    <Modal open={!!target} onClose={close} title={`${project?.name ?? 'Project'} — context`} width={760}>
      <div className="-mt-1 mb-3 flex items-center gap-1 border-b border-border-subtle" role="tablist">
        {(Object.keys(LABEL) as Doc[]).map((d) => (
          <button
            key={d}
            role="tab"
            aria-selected={tab === d}
            onClick={() => setTab(d)}
            className={cn('-mb-px border-b-2 px-1.5 py-2 text-xs font-medium cursor-pointer',
              tab === d ? 'border-accent text-primary' : 'border-transparent text-muted hover:text-secondary')}
          >
            {LABEL[d]}
          </button>
        ))}
        <Button size="sm" variant="ghost" className="mb-1 ml-auto" disabled={busy} onClick={() => void rebuild()} title="Re-scan the project and rewrite the map (uses Haiku)">
          <RefreshCw size={11} className={cn(busy && 'animate-spin')} /> {busy ? 'Rebuilding…' : 'Rebuild map'}
        </Button>
      </div>
      {error && <p role="alert" className="mb-3 text-xs text-danger">{error}</p>}
      <div className="max-h-[58vh] min-h-40 overflow-y-auto pr-1">
        {!ctx && !error && <p className="py-8 text-center text-xs text-faint">Loading…</p>}
        {ctx && (text.trim() ? <div className="text-[13px]"><Prose text={text} /></div> : <p className="py-8 text-center text-xs text-faint">{EMPTY[tab]}</p>)}
      </div>
    </Modal>
  );
}
