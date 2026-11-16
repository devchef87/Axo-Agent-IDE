import { useEffect } from 'react';
import { Plus } from 'lucide-react';
import { useAxo } from '../../stores/store.ts';
import { isElectron } from '../../lib/bridge.ts';
import { useServers } from './use-servers.ts';

/** "+ server" at the bottom of the sidebar; opens Settings → Servers. Flags available node updates. */
export function ServersSidebarEntry() {
  const setUi = useAxo((s) => s.setUi);
  const start = useServers((s) => s.start);
  const updates = useServers((s) => (s.snap ? s.snap.servers.filter((v) => v.status.updateAvailable).length + (s.snap.local.updateAvailable ? 1 : 0) : 0));
  useEffect(() => { start(); }, [start]);
  if (!isElectron) return null;
  return (
    <button
      className="flex h-8 shrink-0 items-center gap-2 border-t border-border-subtle px-3 text-xs text-faint hover:bg-hover hover:text-secondary cursor-pointer"
      title="Servers: add, connect, deploy and update"
      onClick={() => setUi({ servers: true })}
    >
      <Plus size={13} strokeWidth={1.75} /> Servers
      {updates > 0 && <span className="ml-auto font-mono text-2xs text-secondary" title="A node runs an older build">{updates} update{updates > 1 ? 's' : ''}</span>}
    </button>
  );
}
