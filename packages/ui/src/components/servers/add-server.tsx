import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import type { SshHostEntry } from '@axo/protocol';
import { Button, cn, Field, inputCls } from '../ui.tsx';
import { serversApi, useServers } from './use-servers.ts';

/** Add from ~/.ssh/config (one click) or by hand. Adding runs preflight right away. */
export function AddServer({ onDone, existing }: { onDone: () => void; existing: string[] }) {
  const api = serversApi()!;
  const run = useServers((s) => s.run);
  const [tab, setTab] = useState<'config' | 'manual'>('config');
  const [hosts, setHosts] = useState<SshHostEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', host: '', user: '', port: '', identityFile: '' });

  useEffect(() => {
    void api.sshHosts().then((h) => { setHosts(h); if (h.length === 0) setTab('manual'); }, () => setHosts([]));
  }, [api]);

  const add = async (input: Parameters<typeof api.add>[0]) => {
    setBusy(true);
    setError(null);
    try {
      const cfg = await api.add(input);
      onDone();
      void run(cfg.id, 'preflight', () => api.preflight(cfg.id));
    } catch (e: any) {
      setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.host.trim()) return;
    void add({
      name: form.name.trim() || form.host.trim(),
      host: form.host.trim(),
      user: form.user.trim() || undefined,
      port: form.port ? Number(form.port) : undefined,
      identityFile: form.identityFile.trim() || undefined,
    });
  };

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="mt-2 rounded-md border border-border bg-inset p-3">
      <div className="mb-3 flex items-center gap-1 text-xs">
        {(['config', 'manual'] as const).map((t) => (
          <button
            key={t}
            className={cn('rounded px-2 py-1 cursor-pointer', tab === t ? 'bg-control text-primary' : 'text-faint hover:text-secondary')}
            onClick={() => setTab(t)}
          >
            {t === 'config' ? 'From ~/.ssh/config' : 'Manual'}
          </button>
        ))}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onDone}>Cancel</Button>
      </div>

      {tab === 'config' && (
        hosts === null ? <p className="flex items-center gap-2 text-xs text-faint"><Loader2 size={12} className="animate-spin" /> Reading ~/.ssh/config…</p>
        : hosts.length === 0 ? <p className="text-xs text-faint">No hosts found in ~/.ssh/config.</p>
        : (
          <div className="max-h-56 overflow-y-auto rounded border border-border-subtle">
            {hosts.map((h) => {
              const added = existing.includes(h.alias);
              return (
                <div key={h.alias} className="flex items-center gap-3 border-b border-border-subtle bg-panel px-2.5 py-1.5 last:border-b-0">
                  <span className="w-36 truncate text-[13px] text-primary">{h.alias}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-2xs text-faint">
                    {h.user ? `${h.user}@` : ''}{h.hostName ?? h.alias}{h.port ? `:${h.port}` : ''}
                  </span>
                  <Button size="sm" variant={added ? 'ghost' : 'subtle'} disabled={added || busy} onClick={() => void add({ name: h.alias, host: h.alias })}>
                    {added ? 'Added' : 'Add'}
                  </Button>
                </div>
              );
            })}
          </div>
        )
      )}

      {tab === 'manual' && (
        <form onSubmit={submit}>
          <div className="grid grid-cols-2 gap-x-3">
            <Field label="Host" hint="Hostname, IP, or a ~/.ssh/config alias">
              <input autoFocus className={inputCls} value={form.host} onChange={set('host')} placeholder="prod-1.example.com" />
            </Field>
            <Field label="Name" hint="Shown in the sidebar">
              <input className={inputCls} value={form.name} onChange={set('name')} placeholder={form.host || 'prod-1'} />
            </Field>
            <Field label="User">
              <input className={inputCls} value={form.user} onChange={set('user')} placeholder="ubuntu" />
            </Field>
            <Field label="SSH port">
              <input className={inputCls} value={form.port} onChange={set('port')} placeholder="22" inputMode="numeric" />
            </Field>
          </div>
          <Field label="Identity file" hint="Optional. Passphrases come from ssh-agent / Keychain (ssh-add --apple-use-keychain).">
            <input className={inputCls} value={form.identityFile} onChange={set('identityFile')} placeholder="~/.ssh/id_ed25519" />
          </Field>
          <div className="flex justify-end">
            <Button variant="primary" type="submit" disabled={busy || !form.host.trim()}>{busy && <Loader2 size={12} className="animate-spin" />} Add and check</Button>
          </div>
        </form>
      )}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}
