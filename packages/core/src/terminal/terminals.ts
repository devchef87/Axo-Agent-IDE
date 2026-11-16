import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { resolve } from 'node:path';
import type { WebSocket } from 'ws';
import type { CreateTerminalReq, TermClientMsg, TerminalInfo } from '@axo/protocol';
import { ulid } from '../util/ulid.ts';
import { HttpError } from '../util/http-error.ts';

/**
 * PTY bridge without a native module: python3's pty module owns the terminal. stdin/stdout carry raw
 * bytes; fd 3 carries "cols rows\n" resize lines. Closing stdin (node died) hangs up the shell.
 */
const HELPER = String.raw`
import os, pty, sys, select, signal, struct, fcntl, termios
cols, rows = int(sys.argv[1]), int(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[3], sys.argv[3:])
def size(c, r):
    try: fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
    except OSError: pass
size(cols, rows)
def hup(*_):
    try: os.kill(pid, signal.SIGHUP)
    except OSError: pass
signal.signal(signal.SIGHUP, hup)
signal.signal(signal.SIGTERM, hup)
def put(f, d):
    while d:
        n = os.write(f, d)
        d = d[n:]
watch, ctl = [0, fd, 3], b''
while True:
    try: r = select.select(watch, [], [])[0]
    except InterruptedError: continue
    if fd in r:
        try: d = os.read(fd, 65536)
        except OSError: d = b''
        if not d: break
        put(1, d)
    if 0 in r:
        d = os.read(0, 65536)
        if d: put(fd, d)
        else: watch.remove(0); hup()
    if 3 in r:
        d = os.read(3, 1024)
        if not d: watch.remove(3); continue
        ctl += d
        while b'\n' in ctl:
            line, ctl = ctl.split(b'\n', 1)
            try: c, rr = map(int, line.split()); size(c, rr)
            except ValueError: pass
_, st = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 128 + os.WTERMSIG(st))
`;

/** Same internals agents never see (Electron's run-as-node, Axo/Groove/Claude Code session vars). */
const STRIP_ENV = /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_AGENT_SDK_VERSION|GROOVE_.*|AXO_.*|ELECTRON_RUN_AS_NODE)$/;

export const SCROLLBACK_BYTES = 256 * 1024;
export const MAX_TERMINALS = 20;
const DETACHED_TTL_MS = 24 * 60 * 60_000;
const EXITED_TTL_MS = 10 * 60_000;

interface Session {
  info: TerminalInfo;
  proc: ChildProcess;
  chunks: Buffer[];
  bytes: number;
  clients: Set<WebSocket>;
  idleSince: number;       // last time the attach count hit 0 (or exit time)
  killTimer: NodeJS.Timeout | null;
}

export interface TerminalsOptions { python?: string; detachedTtlMs?: number }

export class Terminals {
  private readonly sessions = new Map<string, Session>();
  private readonly sweep: NodeJS.Timeout;
  private readonly o: TerminalsOptions;

  constructor(o: TerminalsOptions = {}) {
    this.o = o;
    this.sweep = setInterval(() => this.reap(), 60_000);
    this.sweep.unref();
  }

  list(): TerminalInfo[] { return [...this.sessions.values()].map((s) => this.view(s)); }

  get(id: string): TerminalInfo {
    return this.view(this.session(id));
  }

  create(req: CreateTerminalReq = {}): Promise<TerminalInfo> {
    if ([...this.sessions.values()].filter((s) => !s.info.exited).length >= MAX_TERMINALS) {
      throw new HttpError(429, `This node already has ${MAX_TERMINALS} open terminals. Close one first.`);
    }
    const cwd = resolve(req.cwd || homedir());
    let ok = false;
    try { ok = statSync(cwd).isDirectory(); } catch { /* missing */ }
    if (!ok) throw new HttpError(400, `Not a directory: ${cwd}`);
    const cols = clamp(req.cols, 80, 2, 1000);
    const rows = clamp(req.rows, 24, 1, 500);
    const shell = process.env.SHELL || safeShell();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP_ENV.test(k)) env[k] = v;
    Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Axo' });
    if (!env.LANG && !env.LC_ALL) env.LANG = 'en_US.UTF-8'; // GUI-launched processes often lack a locale

    return new Promise((res, rej) => {
      const proc = spawn(this.o.python ?? 'python3', ['-c', HELPER, String(cols), String(rows), shell, '-l'], {
        cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      });
      proc.once('error', (e: any) => rej(e.code === 'ENOENT'
        ? new HttpError(503, 'Terminals need python3 on this machine, and it was not found on the PATH.')
        : e));
      proc.once('spawn', () => {
        const s: Session = {
          info: { id: ulid(), cwd, shell, pid: proc.pid!, createdAt: Date.now(), cols, rows, exited: false, exitCode: null, attached: 0 },
          proc, chunks: [], bytes: 0, clients: new Set(), idleSince: Date.now(), killTimer: null,
        };
        this.sessions.set(s.info.id, s);
        proc.stdout!.on('data', (d: Buffer) => this.output(s, d));
        proc.stderr!.on('data', (d: Buffer) => this.output(s, d)); // helper tracebacks: show them, don't hide them
        for (const p of [proc.stdin, proc.stdio[3]] as any[]) p?.on('error', () => {}); // EPIPE after exit
        proc.on('exit', (code, sig) => this.exited(s, code ?? (sig ? 128 + (SIGNALS[sig] ?? 1) : 1)));
        res(this.view(s));
      });
    });
  }

  /** SIGHUP the shell (via the helper), SIGKILL after 2s; forget the session. */
  kill(id: string): void {
    const s = this.session(id);
    this.sessions.delete(id);
    for (const ws of s.clients) ws.close(1000, 'terminal closed');
    if (s.info.exited) return;
    s.proc.kill('SIGHUP');
    s.killTimer = setTimeout(() => s.proc.kill('SIGKILL'), 2000);
    s.killTimer.unref();
  }

  /** True if the id exists (checked before accepting a WS upgrade). */
  has(id: string): boolean { return this.sessions.has(id); }

  attach(id: string, ws: WebSocket): void {
    const s = this.sessions.get(id);
    if (!s) { ws.close(4404, 'no such terminal'); return; }
    if (s.bytes) ws.send(Buffer.concat(s.chunks), { binary: true });
    if (s.info.exited) {
      ws.send(JSON.stringify({ type: 'exit', code: s.info.exitCode ?? 0 }));
      ws.close(1000, 'exited');
      return;
    }
    s.clients.add(ws);
    s.info.attached = s.clients.size;
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (s.info.exited) return;
      if (isBinary) { s.proc.stdin!.write(data); return; }
      let msg: TermClientMsg | null = null;
      try { msg = JSON.parse(data.toString()); } catch { /* not control: treat as input */ }
      if (msg?.type === 'resize') this.resize(s, msg.cols, msg.rows);
      else if (!msg) s.proc.stdin!.write(data);
    });
    ws.on('close', () => {
      s.clients.delete(ws);
      s.info.attached = s.clients.size;
      if (!s.clients.size) s.idleSince = Date.now();
    });
  }

  shutdown(): void {
    clearInterval(this.sweep);
    for (const s of this.sessions.values()) {
      for (const ws of s.clients) ws.close(1001, 'node stopping');
      if (!s.info.exited) s.proc.kill('SIGHUP');
    }
    this.sessions.clear();
  }

  // ── internals ─────────────────────────────────────────────

  private session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, 'No such terminal');
    return s;
  }

  private view(s: Session): TerminalInfo { return { ...s.info }; }

  private output(s: Session, d: Buffer): void {
    s.chunks.push(d);
    s.bytes += d.length;
    while (s.bytes > SCROLLBACK_BYTES && s.chunks.length > 1) s.bytes -= s.chunks.shift()!.length;
    if (s.bytes > SCROLLBACK_BYTES) { // one huge chunk
      s.chunks[0] = s.chunks[0].subarray(s.bytes - SCROLLBACK_BYTES);
      s.bytes = SCROLLBACK_BYTES;
    }
    for (const ws of s.clients) if (ws.readyState === 1) ws.send(d, { binary: true });
  }

  private resize(s: Session, cols: number, rows: number): void {
    s.info.cols = clamp(cols, s.info.cols, 2, 1000);
    s.info.rows = clamp(rows, s.info.rows, 1, 500);
    (s.proc.stdio[3] as NodeJS.WritableStream | null)?.write(`${s.info.cols} ${s.info.rows}\n`);
  }

  private exited(s: Session, code: number): void {
    if (s.killTimer) clearTimeout(s.killTimer);
    s.info.exited = true;
    s.info.exitCode = code;
    s.idleSince = Date.now();
    const msg = JSON.stringify({ type: 'exit', code });
    for (const ws of s.clients) { if (ws.readyState === 1) ws.send(msg); ws.close(1000, 'exited'); }
    s.clients.clear();
    s.info.attached = 0;
  }

  private reap(): void {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      if (s.info.exited ? now - s.idleSince > EXITED_TTL_MS : !s.clients.size && now - s.idleSince > (this.o.detachedTtlMs ?? DETACHED_TTL_MS)) {
        if (s.info.exited) this.sessions.delete(s.info.id); else this.kill(s.info.id);
      }
    }
  }
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

function clamp(v: unknown, dflt: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, min), max) : dflt;
}

function safeShell(): string {
  try { return userInfo().shell || '/bin/sh'; } catch { return '/bin/sh'; }
}
