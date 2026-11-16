import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, ListChecks, Loader2, Plug, Plus, RefreshCw, Trash2, Unplug, Upload, X } from 'lucide-react';
import type { PreflightResult, ServerPhase, ServerView, ServersSnapshot } from '@axo/protocol';
import { useAxo } from '../../stores/store.ts';
import { Button, cn, Modal } from '../ui.tsx';
import { serversApi, useServers } from './use-servers.ts';
import { AddServer } from './add-server.tsx';

/** Settings → Servers: add, preflight, deploy, connect, update, remove. */
export function ServersPanel() {
  const open = useAxo((s) => s.ui.servers);
  const setUi = useAxo((s) => s.setUi);
  const snap = useServers((s) => s.snap);
  const start = useServers((s) => s.start);
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (open) start(); }, [open, start]);
  useEffect(() => { if (open && snap && snap.servers.length === 0) setAdding(true); }, [open, snap]);

  const close = () => { setUi({ servers: false }); setAdding(false); };

  return (
    <Modal open={open} onClose={close} title="Servers" width={760}>
      {!serversApi() ? (
        <p className="text-[13px] text-muted">Servers are managed by the Axo desktop app.</p>
      ) : !snap ? (
        <p className="flex items-center gap-2 text-[13px] text-muted"><Loader2 size={13} className="animate-spin" /> Loading…</p>
      ) : (
        <div className="-m-4 flex max-h-[70vh] flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <LocalRow snap={snap} />
            {snap.servers.map((v) => <ServerRow key={v.config.id} view={v} bundledBuild={snap.bundled.build} />)}
            {adding
              ? <AddServer onDone={() => setAdding(false)} existing={snap.servers.map((s) => s.config.host)} />
              : (
                <button
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-2.5 text-xs text-faint hover:border-accent/60 hover:text-secondary cursor-pointer"
                  onClick={() => setAdding(true)}
                >
                  <Plus size={13} /> Add server
                </button>
              )}
          </div>
          <p className="border-t border-border-subtle px-4 py-2 text-2xs text-faint">
            Axo connects with your system <code className="font-mono">ssh</code>, so keys come from ssh-agent, Keychain and ~/.ssh/config. Nothing secret is stored.
            Bundled node build <span className="font-mono">{snap.bundled.build}</span>.
          </p>
        </div>
      )}
    </Modal>
  );
}

function LocalRow({ snap }: { snap: ServersSnapshot }) {
  const { local } = snap;
  const api = serversApi()!;
  return (
    <div className="mb-2 rounded-md border border-border-subtle bg-inset px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted" />
        <span className="text-[13px] font-medium text-primary">Local</span>
        <span className="text-2xs text-faint">this Mac</span>
        <VersionTag build={local.node?.build} stale={local.updateAvailable} />
        <div className="ml-auto flex items-center gap-1.5">
          {local.updateWaiting
            ? <Button size="sm" variant="ghost" onClick={() => void api.cancelLocalUpdate()}>Cancel update</Button>
            : local.updateAvailable && (
              <Button size="sm" variant="primary" onClick={() => void api.updateLocal()} title="Restarts the local node once no agent is mid-turn; agents resume by session">
                <RefreshCw size={12} /> Restart on new build
              </Button>
            )}
        </div>
      </div>
      {local.message && <p className="mt-1 pl-3.5 text-xs text-muted">{local.message}</p>}
    </div>
  );
}

const PHASE: Record<ServerPhase, { label: string; dot: string }> = {
  idle: { label: 'not connected', dot: 'bg-faint' },
  preflight: { label: 'checking', dot: 'bg-working animate-pulse-dot' },
  deploying: { label: 'deploying', dot: 'bg-working animate-pulse-dot' },
  updating: { label: 'updating', dot: 'bg-working animate-pulse-dot' },
  connecting: { label: 'connecting', dot: 'bg-warning animate-pulse-dot' },
  reconnecting: { label: 'reconnecting', dot: 'bg-warning animate-pulse-dot' },
  connected: { label: 'connected', dot: 'bg-muted' },
  error: { label: 'error', dot: 'bg-danger' },
};

function ServerRow({ view, bundledBuild }: { view: ServerView; bundledBuild: string }) {
  const { config: c, status: st } = view;
  const pending = useServers((s) => s.pending[c.id]);
  const run = useServers((s) => s.run);
  const api = serversApi()!;
  const [error, setError] = useState<string | null>(null);
  const [showChecks, setShowChecks] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setError(null);
    const err = await run(c.id, label, fn);
    if (err) setError(err);
  };

  const connected = c.autoConnect; // set by connect, cleared by disconnect
  const busy = !!pending || st.phase === 'preflight' || st.phase === 'deploying' || st.phase === 'updating';
  const deployed = !!st.node || !!st.preflight?.deployedBuild || !!st.deployMode;
  const where = `${c.user ? `${c.user}@` : ''}${c.host}${c.port ? `:${c.port}` : ''}`;
  const phase = PHASE[st.phase];
  // The main process already reports deploy/connect failures in st.message; show the thrown error only if it adds something.
  const shownError = error && error !== st.message ? error : null;

  return (
    <div className="mb-2 rounded-md border border-border-subtle bg-inset px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', phase.dot)} />
        <span className="truncate text-[13px] font-medium text-primary">{c.name}</span>
        <span className="truncate font-mono text-2xs text-faint">{where}</span>
        <span className="text-2xs text-faint">· {phase.label}</span>
        <VersionTag build={st.node?.build} stale={st.updateAvailable} />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setShowChecks(true); void act('preflight', () => api.preflight(c.id)); }} title="Check OS, node, claude login, git, disk">
            {pending === 'preflight' ? <Loader2 size={12} className="animate-spin" /> : <ListChecks size={12} />} Preflight
          </Button>
          {st.updateWaiting ? (
            <Button size="sm" variant="ghost" onClick={() => void api.cancelUpdate(c.id)}>Cancel update</Button>
          ) : (
            <Button
              size="sm"
              variant={st.updateAvailable || !deployed ? 'primary' : 'ghost'}
              disabled={busy}
              onClick={() => void act('deploy', () => api.deploy(c.id))}
              title={st.phase === 'connected' ? 'Waits until no agent is mid-turn, then restarts the node; agents resume by session' : `Upload the node (build ${bundledBuild}) and start it`}
            >
              {pending === 'deploy' ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              {st.updateAvailable ? 'Update' : deployed ? 'Redeploy' : 'Deploy'}
            </Button>
          )}
          {connected ? (
            <Button size="sm" variant="ghost" disabled={!!pending} onClick={() => void act('disconnect', () => api.disconnect(c.id))} title="Close the tunnel. The node and its agents keep running on the server.">
              <Unplug size={12} /> Disconnect
            </Button>
          ) : (
            <Button size="sm" variant={deployed && !st.updateAvailable ? 'primary' : 'subtle'} disabled={busy} onClick={() => void act('connect', () => api.connect(c.id))}>
              <Plug size={12} /> Connect
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmRemove(true)} title="Remove from Axo"><Trash2 size={12} /></Button>
        </div>
      </div>

      {(st.message || shownError) && (
        <p className={cn('mt-1 whitespace-pre-wrap pl-3.5 text-xs', st.phase === 'error' || shownError ? 'text-danger' : 'text-muted')}>{shownError ?? st.message}</p>
      )}

      {confirmRemove && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-control px-3 py-2 text-xs text-secondary">
          <span className="mr-auto">Remove <b>{c.name}</b> from Axo?</span>
          <Button size="sm" variant="subtle" onClick={() => void act('remove', () => api.remove(c.id))} title="The node and its agents keep running on the server">Remove, keep node running</Button>
          <Button size="sm" variant="danger" onClick={() => void act('remove', () => api.remove(c.id, { stopNode: true }))}>Remove and stop node</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>Cancel</Button>
        </div>
      )}

      {st.preflight && (
        <div className="mt-1.5 pl-3.5">
          <button className="flex items-center gap-1 text-2xs text-faint hover:text-secondary cursor-pointer" onClick={() => setShowChecks(!showChecks)}>
            {showChecks ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            Preflight {st.preflight.ok ? 'passed' : 'found problems'} · {new Date(st.preflight.ts).toLocaleTimeString()}
          </button>
          {showChecks && <Checks result={st.preflight} />}
        </div>
      )}
    </div>
  );
}

function Checks({ result }: { result: PreflightResult }) {
  return (
    <div className="mt-1 overflow-hidden rounded border border-border-subtle">
      {result.checks.map((c) => (
        <div key={c.id} className="flex items-start gap-2 border-b border-border-subtle bg-panel px-2.5 py-1.5 text-xs last:border-b-0">
          {c.status === 'pass' && <Check size={13} className="mt-px shrink-0 text-muted" />}
          {c.status === 'warn' && <AlertTriangle size={13} className="mt-px shrink-0 text-warning" />}
          {c.status === 'fail' && <X size={13} className="mt-px shrink-0 text-danger" />}
          <span className="w-32 shrink-0 text-secondary">{c.label}</span>
          <span className={cn('min-w-0 break-words', c.status === 'fail' ? 'text-danger' : 'text-muted')}>{c.detail}</span>
        </div>
      ))}
    </div>
  );
}

function VersionTag({ build, stale }: { build?: string; stale: boolean }) {
  if (!build) return null;
  return (
    <span
      className={cn('rounded px-1 font-mono text-2xs', stale ? 'bg-warning/15 text-warning' : 'bg-control text-faint')}
      title={stale ? 'Running an older build than this app bundles' : 'Running the bundled build'}
    >
      {build}{stale && ' · update'}
    </span>
  );
}
