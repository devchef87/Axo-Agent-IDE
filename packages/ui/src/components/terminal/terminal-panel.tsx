import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { ChevronDown, ChevronUp, Plus, SquareTerminal, Trash2, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { tryClient, useAxo } from '../../stores/store.ts';
import { contextPlace, useTerminals, type TermPlace } from '../../stores/terminals.ts';
import { cwdLabel, type TermTab } from '../../lib/terminal-model.ts';
import { terminalFont, terminalTheme } from '../../lib/terminal-theme.ts';
import { useTheme } from '../../lib/theme.ts';
import { cn, IconButton, useDismiss } from '../ui.tsx';

/** Bottom panel (⌃` / ⌘J). Stays mounted while hidden so shells keep their screen and socket. */
export function TerminalPanel() {
  const open = useTerminals((s) => s.open);
  const height = useTerminals((s) => s.height);
  const tabs = useTerminals((s) => s.tabs);
  const active = useTerminals((s) => s.active);
  const error = useTerminals((s) => s.error);
  const panel = useRef<HTMLDivElement>(null);

  const startResize = (e: RPointerEvent) => {
    e.preventDefault();
    const startY = e.clientY, startH = height;
    const max = () => (panel.current?.parentElement?.clientHeight ?? 800) - 120;
    const move = (ev: PointerEvent) => useTerminals.getState().setHeight(Math.min(max(), startH + startY - ev.clientY));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
    document.body.style.cursor = 'row-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <section
      ref={panel}
      aria-label="Terminal"
      hidden={!open}
      style={{ height }}
      className="relative flex shrink-0 flex-col border-t border-border bg-panel shadow-[0_-6px_16px_rgb(8_16_22/0.25)]"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        tabIndex={0}
        onPointerDown={startResize}
        onDoubleClick={() => useTerminals.getState().setHeight(280)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); useTerminals.getState().setHeight(height + (e.key === 'ArrowUp' ? 24 : -24)); }
        }}
        className="absolute inset-x-0 -top-[3px] z-10 h-[6px] cursor-row-resize hover:bg-border-strong/40"
      />
      <TerminalBar tabs={tabs} active={active} />
      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1 text-xs text-danger">
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <IconButton title="Dismiss" onClick={() => useTerminals.setState({ error: null })}><X size={12} /></IconButton>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {tabs.map((t) => <TerminalView key={t.key} tab={t} shown={open && t.key === active} />)}
        {!tabs.length && (
          <div className="flex h-full items-center justify-center">
            <button onClick={() => void useTerminals.getState().create()} className="flex items-center gap-1.5 text-xs text-faint hover:text-primary cursor-pointer">
              <Plus size={12} /> New terminal
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function TerminalBar({ tabs, active }: { tabs: TermTab[]; active: string | null }) {
  const nodes = useAxo((s) => s.nodes);
  const multiNode = new Set(tabs.map((t) => t.nodeKey)).size > 1 || tabs.some((t) => t.nodeKey !== 'local');
  const { select, close, setOpen } = useTerminals.getState();
  const activeTab = tabs.find((t) => t.key === active);
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border-subtle pl-3 pr-1.5">
      <span className="label mr-2">Terminal</span>
      <div role="tablist" aria-label="Terminals" className="flex min-w-0 flex-1 items-center overflow-x-auto">
        {tabs.map((t) => {
          const node = nodes[t.nodeKey];
          const sel = t.key === active;
          return (
            <div
              key={t.key}
              role="tab"
              aria-selected={sel}
              tabIndex={0}
              title={`${node?.name ?? t.nodeKey} · ${t.cwd}${t.exited ? ` · exited (${t.exitCode})` : ''}`}
              onClick={() => select(t.key)}
              onAuxClick={(e) => { if (e.button === 1) void close(t.key); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(t.key); } }}
              className={cn('group relative flex h-8 shrink-0 items-center gap-1.5 pl-2 pr-1 font-mono text-2xs cursor-pointer',
                sel ? 'text-primary' : 'text-faint hover:text-secondary')}
            >
              <SquareTerminal size={11} strokeWidth={1.75} />
              {multiNode && <span className="text-faint">{node?.name ?? t.nodeKey}:</span>}
              <span className={cn(t.exited && 'line-through decoration-faint')}>{cwdLabel(t.cwd)}</span>
              <button
                title="Close terminal"
                aria-label="Close terminal"
                onClick={(e) => { e.stopPropagation(); void close(t.key); }}
                className={cn('flex h-4 w-4 items-center justify-center rounded hover:bg-hover cursor-pointer', sel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
              >
                <X size={10} />
              </button>
              {sel && <span className="absolute inset-x-2 bottom-0 h-px bg-accent" aria-hidden />}
            </div>
          );
        })}
      </div>
      <NewTerminalButton />
      {activeTab && <IconButton title="Kill terminal" onClick={() => void close(activeTab.key)}><Trash2 size={12} /></IconButton>}
      <IconButton title="Hide terminal (⌃`)" onClick={() => setOpen(false)}><ChevronDown size={13} /></IconButton>
    </div>
  );
}

/** "+" opens where you're working; the chevron lists every connected server and project. */
function NewTerminalButton() {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, menu, () => setMenu(false));
  const nodes = useAxo((s) => s.nodes);
  const order = useAxo((s) => s.nodeOrder);
  const here = menu ? contextPlace() : null;
  const places: TermPlace[] = order.filter((k) => nodes[k].status === 'online').flatMap((k) => [
    { nodeKey: k, label: `${nodes[k].name} · ~` },
    ...nodes[k].projects.map((p) => ({ nodeKey: k, cwd: p.path, label: `${nodes[k].name} · ${p.name}` })),
  ]);
  const pick = (p: TermPlace) => { setMenu(false); void useTerminals.getState().create(p); };
  return (
    <div ref={ref} className="relative flex items-center">
      <IconButton title={`New terminal${contextPlace() ? ` in ${contextPlace()!.label}` : ''}`} onClick={() => void useTerminals.getState().create()}><Plus size={13} /></IconButton>
      <IconButton title="New terminal in…" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} className="w-4">
        <ChevronUp size={11} />
      </IconButton>
      {menu && (
        <div role="menu" className="absolute bottom-full right-0 z-30 mb-1 max-h-80 w-64 overflow-y-auto rounded border border-border bg-elevated py-1 shadow-[var(--shadow)]">
          {here && (
            <>
              <MenuItem label={here.label} hint="here" onClick={() => pick(here)} />
              <div className="my-1 border-t border-border-subtle" />
            </>
          )}
          {places.map((p) => <MenuItem key={`${p.nodeKey}|${p.cwd ?? ''}`} label={p.label} onClick={() => pick(p)} />)}
          {!places.length && <div className="px-3 py-1.5 text-xs text-faint">No server is connected.</div>}
        </div>
      )}
    </div>
  );
}

function MenuItem({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) {
  return (
    <button role="menuitem" onClick={onClick} className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-secondary hover:bg-hover hover:text-primary cursor-pointer">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="font-mono text-2xs text-faint">{hint}</span>}
    </button>
  );
}

const enc = new TextEncoder();

/**
 * One xterm bound to one node session over WS /ws/term/:id. The node replays scrollback on every
 * attach, so a reconnect resets the screen first. Mounted for the tab's lifetime; hidden when not shown.
 */
function TerminalView({ tab, shown }: { tab: TermTab; shown: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: () => void; reconnect: () => void } | null>(null);
  const [status, setStatus] = useState<'connecting' | 'live' | 'waiting'>('connecting');
  const theme = useTheme((s) => s.theme);
  const focusRev = useTerminals((s) => s.focusRev);
  const nodeOnline = useAxo((s) => s.nodes[tab.nodeKey]?.status === 'online');

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: terminalFont(),
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10_000,
      macOptionIsMeta: true,
      allowProposedApi: false,
      theme: terminalTheme(useTheme.getState().theme),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    const fit = () => { if (el.clientWidth > 0 && el.clientHeight > 0) { try { fitAddon.fit(); } catch { /* not laid out yet */ } } };

    // App shortcuts (⌘K, ⌘E, ⌘1…) pass through; ⌘C copies the selection; ⌘V pastes natively.
    term.attachCustomKeyEventHandler((e) => {
      if (!e.metaKey) return true;
      if (e.type === 'keydown' && e.key === 'c' && term.hasSelection()) { void navigator.clipboard.writeText(term.getSelection()); return false; }
      if (e.type === 'keydown' && e.key === 'a') { term.selectAll(); return false; }
      return false;
    });

    let ws: WebSocket | null = null;
    let disposed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = (data: string | Uint8Array) => { if (ws?.readyState === WebSocket.OPEN) ws.send(data); };
    const sendSize = () => send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));

    const connect = () => {
      timer = null;
      if (disposed) return;
      const c = tryClient(tab.nodeKey);
      if (!c || useAxo.getState().nodes[tab.nodeKey]?.status !== 'online') { setStatus('waiting'); return; }
      setStatus('connecting');
      const url = c.conn.baseUrl.replace(/^http/, 'ws') + `/ws/term/${tab.id}?token=${encodeURIComponent(c.conn.token)}`;
      const sock = new WebSocket(url);
      sock.binaryType = 'arraybuffer';
      ws = sock;
      let first = true;
      sock.onopen = () => { retry = 0; setStatus('live'); fit(); sendSize(); };
      sock.onmessage = (m) => {
        if (typeof m.data === 'string') {
          try {
            const msg = JSON.parse(m.data);
            if (msg?.type === 'exit') {
              term.write(`\r\n\x1b[2m[process exited with code ${msg.code}]\x1b[0m\r\n`);
              useTerminals.getState().markExited(tab.key, msg.code);
            }
          } catch { /* ignore */ }
          return;
        }
        if (first) { first = false; term.reset(); } // the node replays scrollback on every attach
        term.write(new Uint8Array(m.data as ArrayBuffer));
      };
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        if (disposed || useTerminals.getState().tabs.find((t) => t.key === tab.key)?.exited) return;
        // Session gone (node restarted)? Drop the tab. Otherwise the tunnel blinked: reconnect.
        c.get<{ id: string }[]>('/terminals').then(
          (list) => {
            if (disposed) return;
            if (!list.some((t) => t.id === tab.id)) { useTerminals.getState().forget(tab.key); return; }
            setStatus('waiting');
            timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
          },
          () => { if (!disposed) { setStatus('waiting'); timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++)); } },
        );
      };
    };

    const dataSub = term.onData((d) => send(enc.encode(d)));
    const binSub = term.onBinary((d) => send(Uint8Array.from(d, (ch) => ch.charCodeAt(0) & 0xff)));
    const resizeSub = term.onResize(() => sendSize());
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    if (!tab.exited) connect();
    else term.write(`\x1b[2m[process exited with code ${tab.exitCode}]\x1b[0m\r\n`);
    termRef.current = { term, fit, reconnect: () => { if (!ws && !disposed && !timer) connect(); } };

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      ro.disconnect();
      dataSub.dispose(); binSub.dispose(); resizeSub.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [tab.nodeKey, tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Node came back after a disconnect: attach again.
  useEffect(() => {
    if (nodeOnline && status === 'waiting') termRef.current?.reconnect();
  }, [nodeOnline, status]);

  useEffect(() => { if (termRef.current) termRef.current.term.options.theme = terminalTheme(theme); }, [theme]);

  useEffect(() => {
    if (!shown || !termRef.current) return;
    const { term, fit } = termRef.current;
    requestAnimationFrame(() => { fit(); term.focus(); });
  }, [shown, focusRev]);

  return (
    <div className={cn('absolute inset-0 flex flex-col', !shown && 'invisible')} aria-hidden={!shown}>
      {status === 'waiting' && !tab.exited && (
        <div className="shrink-0 px-3 py-1 font-mono text-2xs text-faint">
          {nodeOnline ? 'Reconnecting…' : `Waiting for ${useAxo.getState().nodes[tab.nodeKey]?.name ?? tab.nodeKey} to connect…`}
        </div>
      )}
      <div ref={host} className="axo-term min-h-0 flex-1 pl-3 pt-1.5" />
    </div>
  );
}
