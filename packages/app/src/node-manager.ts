// Server registry + connection supervisor. Electron-free so it can be tested
// with a fake ssh; main.ts wires it to IPC and powerMonitor.
//
// Per connected server, one async loop: ensure the node runs and read its token
// (ssh), open `ssh -N -L`, wait for /api/health through it, then watch until the
// tunnel dies; back off and repeat. The local port stays stable across
// reconnects so the renderer's NodeClient simply reconnects and replays events.

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type {
  Agent, LocalNodeStatus, NodeState, ServerConfig, ServerInput, ServerStatus, ServersSnapshot, SshHostEntry, VersionInfo,
} from '@axo/protocol';
import { sshTunnel, validateTarget, parseSshConfig, explainSshError, type SshEnv, type SshTarget } from './ssh.ts';
import { runPreflight, deploy, startAndReadToken, stopRemote } from './remote.ts';

export interface NodeConn { key: string; name: string; baseUrl: string; token: string; kind: 'local' | 'remote' }

export interface LocalNodeRef { baseUrl: string; token: string }

export interface NodeManagerOptions {
  dataDir: string;
  sshEnv: SshEnv;
  readBundle: () => Buffer;
  bundleInfo: { version: string; build: string };
  /** Restart the local node with the bundled build. Returns the new connection. */
  restartLocal?: () => Promise<LocalNodeRef>;
  sshConfigPath?: string;
  /** Test hooks */
  healthTimeoutMs?: number;
  idlePollMs?: number;
}

interface ServerEntry {
  config: ServerConfig;
  status: ServerStatus;
  token?: string;
  want: boolean;             // user wants it connected
  child: ChildProcess | null;
  wake: (() => void) | null; // interrupts the backoff sleep / watch
  loop: Promise<void> | null;
  busy: boolean;             // preflight/deploy in progress
  cancelUpdate: boolean;
}

const BUSY: Agent['status'][] = ['working', 'starting', 'rotating'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      srv.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

async function httpJson<T>(baseUrl: string, path: string, token?: string, timeoutMs = 4000): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

export const isStale = (node: VersionInfo | undefined, bundledBuild: string) =>
  !!node && node.build !== bundledBuild && node.build !== 'dev' && bundledBuild !== 'dev';

export class NodeManager extends EventEmitter {
  private readonly o: NodeManagerOptions;
  private readonly servers = new Map<string, ServerEntry>();
  private local: LocalNodeRef | null = null;
  private localStatus: LocalNodeStatus = { updateAvailable: false, updateWaiting: false };
  private readonly file: string;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastConns = '';

  constructor(o: NodeManagerOptions) {
    super();
    this.o = o;
    mkdirSync(o.dataDir, { recursive: true });
    mkdirSync(o.sshEnv.controlDir, { recursive: true, mode: 0o700 });
    this.file = join(o.dataDir, 'servers.json');
    for (const config of this.load()) this.servers.set(config.id, this.entry(config));
  }

  // ── persistence ───────────────────────────────────────────

  private load(): ServerConfig[] {
    if (!existsSync(this.file)) return [];
    try { return (JSON.parse(readFileSync(this.file, 'utf8')).servers ?? []) as ServerConfig[]; } catch { return []; }
  }

  private save(): void {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify({ servers: [...this.servers.values()].map((s) => s.config) }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private entry(config: ServerConfig): ServerEntry {
    return {
      config, want: false, child: null, wake: null, loop: null, busy: false, cancelUpdate: false,
      status: { phase: 'idle', updateAvailable: false, updateWaiting: false },
    };
  }

  // ── snapshot / events ─────────────────────────────────────

  snapshot(): ServersSnapshot {
    return {
      bundled: this.o.bundleInfo,
      local: { ...this.localStatus },
      servers: [...this.servers.values()].map((s) => ({ config: { ...s.config }, status: { ...s.status } })),
    };
  }

  /** Connections the renderer should hold: local + every server we're connected (or reconnecting) to. */
  conns(): NodeConn[] {
    const out: NodeConn[] = [];
    if (this.local) out.push({ key: 'local', name: 'Local', baseUrl: this.local.baseUrl, token: this.local.token, kind: 'local' });
    for (const s of this.servers.values()) {
      if (s.want && s.token && s.status.localPort) {
        out.push({ key: s.config.id, name: s.config.name, baseUrl: `http://127.0.0.1:${s.status.localPort}`, token: s.token, kind: 'remote' });
      }
    }
    return out;
  }

  private changed(): void {
    // Coalesce bursts of status updates into one IPC message.
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('snapshot', this.snapshot());
      const conns = this.conns();
      const sig = JSON.stringify(conns);
      if (sig !== this.lastConns) { this.lastConns = sig; this.emit('nodes', conns); }
    }, 30);
  }

  private setStatus(s: ServerEntry, patch: Partial<ServerStatus>): void {
    s.status = { ...s.status, ...patch };
    this.changed();
  }

  private get(id: string): ServerEntry {
    const s = this.servers.get(id);
    if (!s) throw new Error(`Unknown server ${id}`);
    return s;
  }

  private target(s: ServerEntry): SshTarget {
    const { host, user, port, identityFile } = s.config;
    return { host, user, port, identityFile };
  }

  // ── registry ──────────────────────────────────────────────

  sshHosts(): SshHostEntry[] {
    return parseSshConfig(this.o.sshConfigPath);
  }

  add(input: ServerInput): ServerConfig {
    const name = (input.name || input.host).trim();
    const config: ServerConfig = {
      id: this.uniqueId(name),
      name,
      host: input.host.trim(),
      user: input.user?.trim() || undefined,
      port: input.port || undefined,
      identityFile: input.identityFile?.trim() || undefined,
      remotePort: input.remotePort || 31500,
      autoConnect: input.autoConnect ?? false,
    };
    validateTarget(config);
    this.servers.set(config.id, this.entry(config));
    this.save();
    this.changed();
    return config;
  }

  update(id: string, patch: Partial<ServerInput>): ServerConfig {
    const s = this.get(id);
    const next: ServerConfig = { ...s.config, ...patch, id };
    validateTarget(next);
    s.config = next;
    this.save();
    this.changed();
    return next;
  }

  /** Forget a server. Leaves the node running on the server (agents keep working); `stopNode` stops it first. */
  async remove(id: string, opts: { stopNode?: boolean } = {}): Promise<void> {
    const s = this.get(id);
    await this.disconnect(id);
    if (opts.stopNode) await stopRemote(this.o.sshEnv, this.target(s));
    this.servers.delete(id);
    this.save();
    this.changed();
  }

  private uniqueId(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server';
    let id = base === 'local' ? 'local-server' : base;
    for (let i = 2; this.servers.has(id); i++) id = `${base}-${i}`;
    return id;
  }

  // ── preflight / deploy ────────────────────────────────────

  async preflight(id: string) {
    const s = this.get(id);
    if (s.busy) throw new Error('Another operation is running for this server');
    s.busy = true;
    const prev = s.status.phase;
    this.setStatus(s, { phase: 'preflight', message: 'Running checks…' });
    try {
      const res = await runPreflight(this.o.sshEnv, this.target(s), s.config.remotePort);
      this.setStatus(s, { preflight: res, phase: prev === 'preflight' ? 'idle' : prev, message: res.ok ? undefined : 'Preflight found problems' });
      return res;
    } catch (e: any) {
      this.setStatus(s, { phase: 'error', message: e.message });
      throw e;
    } finally {
      s.busy = false;
    }
  }

  /**
   * Upload the bundled node and (re)start it. If we're connected, first waits
   * until no agent is mid-turn (they resume by session after the restart).
   */
  async deploy(id: string): Promise<void> {
    const s = this.get(id);
    if (s.busy) throw new Error('Another operation is running for this server');
    s.busy = true;
    s.cancelUpdate = false;
    const resumePhase = s.status.phase === 'connected' || s.status.phase === 'reconnecting' ? s.status.phase : 'idle';
    try {
      if (s.token && s.status.localPort && s.status.phase === 'connected') {
        this.setStatus(s, { updateWaiting: true, message: 'Waiting for agents to finish their turns…' });
        const ok = await this.waitIdle(`http://127.0.0.1:${s.status.localPort}`, s.token, () => s.cancelUpdate || !this.servers.has(id),
          (n) => this.setStatus(s, { message: `Waiting for ${n} agent${n === 1 ? '' : 's'} to finish…` }));
        this.setStatus(s, { updateWaiting: false });
        if (!ok) { this.setStatus(s, { message: 'Update cancelled' }); return; }
      }
      this.setStatus(s, { phase: 'deploying', message: 'Checking server…' });
      const pf = await runPreflight(this.o.sshEnv, this.target(s), s.config.remotePort);
      this.setStatus(s, { preflight: pf });
      if (!pf.ok || !pf.nodePath || !pf.pathEnv) {
        const bad = pf.checks.filter((c) => c.status === 'fail').map((c) => `${c.label}: ${c.detail}`).join('\n');
        throw new Error(`Preflight failed:\n${bad}`);
      }
      const res = await deploy(this.o.sshEnv, this.target(s), {
        nodePath: pf.nodePath, nodeFlags: pf.nodeFlags, pathEnv: pf.pathEnv, remotePort: s.config.remotePort,
        bundle: this.o.readBundle(), bundleInfo: this.o.bundleInfo, allowSystemd: pf.systemd,
      }, (m) => this.setStatus(s, { message: m }));
      this.setStatus(s, { deployMode: res.mode, phase: resumePhase, message: res.warnings[0] ?? `Deployed (${res.mode})` });
      if (s.want) {
        await this.refreshVersion(s);
        s.wake?.(); // re-read token / re-probe through the tunnel
      }
    } catch (e: any) {
      this.setStatus(s, { phase: 'error', message: e.message, updateWaiting: false });
      throw e;
    } finally {
      s.busy = false;
    }
  }

  cancelUpdate(id: string): void {
    const s = this.get(id);
    s.cancelUpdate = true;
  }

  // ── connect / disconnect ──────────────────────────────────

  connect(id: string): void {
    const s = this.get(id);
    if (!s.config.autoConnect) { s.config.autoConnect = true; this.save(); }
    if (s.want && s.loop) { s.wake?.(); return; }
    s.want = true;
    s.loop = this.supervise(s).finally(() => { s.loop = null; });
  }

  async disconnect(id: string): Promise<void> {
    const s = this.get(id);
    if (s.config.autoConnect) { s.config.autoConnect = false; this.save(); }
    s.want = false;
    s.child?.kill();
    s.wake?.();
    await s.loop;
    this.setStatus(s, { phase: 'idle', message: undefined, node: undefined });
  }

  connectAutos(): void {
    for (const s of this.servers.values()) if (s.config.autoConnect) this.connect(s.config.id);
  }

  /** Mac woke up or network changed: reconnect now instead of waiting for keepalives / backoff. */
  kickAll(): void {
    for (const s of this.servers.values()) {
      if (!s.want) continue;
      s.child?.kill();
      s.wake?.();
    }
  }

  async shutdown(): Promise<void> {
    for (const s of this.servers.values()) { s.want = false; s.child?.kill(); s.wake?.(); }
    await Promise.all([...this.servers.values()].map((s) => s.loop));
  }

  private async supervise(s: ServerEntry): Promise<void> {
    let attempt = 0;
    while (s.want) {
      let reason = '';
      try {
        this.setStatus(s, { phase: attempt === 0 ? 'connecting' : 'reconnecting', message: 'Starting node…' });
        const token = await startAndReadToken(this.o.sshEnv, this.target(s));
        if (!s.want) break;
        s.token = token;
        if (!s.status.localPort) this.setStatus(s, { localPort: await freePort() });
        reason = await this.tunnelSession(s, () => { attempt = 0; });
      } catch (e: any) {
        reason = e.message;
      }
      if (!s.want) break;
      if (reason === 'reconnect requested') { attempt = 0; continue; }
      const delay = Math.min(2000 * 2 ** attempt, 60_000) + Math.random() * 500;
      attempt++;
      this.setStatus(s, { phase: 'reconnecting', message: `${reason} — retrying in ${Math.round(delay / 1000)}s` });
      await new Promise<void>((r) => { const t = setTimeout(r, delay); s.wake = () => { clearTimeout(t); r(); }; });
      s.wake = null;
    }
    s.child?.kill();
    s.child = null;
  }

  /** One tunnel lifetime. Resolves with the reason it ended. */
  private tunnelSession(s: ServerEntry, onUp: () => void): Promise<string> {
    return new Promise((resolve) => {
      const port = s.status.localPort!;
      const base = `http://127.0.0.1:${port}`;
      const child = sshTunnel(this.o.sshEnv, this.target(s), port, s.config.remotePort);
      s.child = child;
      let stderr = '';
      let settled = false;
      let up = false;
      let watch: ReturnType<typeof setInterval> | null = null;
      const end = (why: string) => {
        if (settled) return;
        settled = true;
        if (watch) clearInterval(watch);
        s.wake = null;
        if (s.child === child) s.child = null;
        child.kill();
        resolve(why);
      };
      s.wake = () => end('reconnect requested');
      child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      child.on('error', (e) => end(`ssh failed: ${e.message}`));
      child.on('exit', (code) => {
        if (/Address already in use|cannot listen to port|Could not request local forwarding/i.test(stderr)) {
          s.status.localPort = undefined; // pick a new port next time (renderer gets the new baseUrl)
          end(`local port ${port} unavailable`);
        } else end(up ? 'tunnel closed' : explainSshError(stderr, code ?? 255));
      });

      const deadline = Date.now() + (this.o.healthTimeoutMs ?? 20_000);
      const probe = async () => {
        while (!settled && Date.now() < deadline) {
          try {
            await httpJson(base, '/api/health', undefined, 1500);
            up = true;
            onUp();
            this.setStatus(s, { phase: 'connected', message: undefined });
            await this.refreshVersion(s);
            let misses = 0;
            watch = setInterval(async () => {
              try { await httpJson(base, '/api/health', undefined, 3000); misses = 0; } catch { if (++misses >= 3) end('node stopped responding'); }
            }, 10_000);
            return;
          } catch { await sleep(300); }
        }
        end('node did not answer through the tunnel');
      };
      void probe();
    });
  }

  private async refreshVersion(s: ServerEntry): Promise<void> {
    if (!s.token || !s.status.localPort) return;
    try {
      const v = await httpJson<VersionInfo>(`http://127.0.0.1:${s.status.localPort}`, '/api/version', s.token);
      this.setStatus(s, { node: v, updateAvailable: isStale(v, this.o.bundleInfo.build) });
    } catch { /* next probe */ }
  }

  // ── local node ────────────────────────────────────────────

  async setLocal(ref: LocalNodeRef | null): Promise<void> {
    this.local = ref;
    if (ref) {
      try {
        const v = await httpJson<VersionInfo>(ref.baseUrl, '/api/version', ref.token);
        this.localStatus = { ...this.localStatus, node: v, updateAvailable: isStale(v, this.o.bundleInfo.build) };
      } catch (e: any) {
        this.localStatus = { ...this.localStatus, message: e.message };
      }
    }
    this.changed();
  }

  private localUpdating = false;
  private cancelLocal = false;

  /** Restart the local node on the bundled build once no agent is mid-turn. */
  async updateLocal(): Promise<void> {
    if (!this.local || !this.o.restartLocal || this.localUpdating) return;
    this.localUpdating = true;
    this.cancelLocal = false;
    try {
      this.localStatus = { ...this.localStatus, updateWaiting: true, message: 'Waiting for agents to finish their turns…' };
      this.changed();
      const ok = await this.waitIdle(this.local.baseUrl, this.local.token, () => this.cancelLocal, (n) => {
        this.localStatus = { ...this.localStatus, message: `Waiting for ${n} agent${n === 1 ? '' : 's'} to finish…` };
        this.changed();
      });
      this.localStatus = { ...this.localStatus, updateWaiting: false, message: ok ? 'Restarting…' : 'Update cancelled' };
      this.changed();
      if (!ok) return;
      const ref = await this.o.restartLocal();
      this.localStatus = { ...this.localStatus, message: undefined };
      await this.setLocal(ref);
    } catch (e: any) {
      this.localStatus = { ...this.localStatus, updateWaiting: false, message: e.message };
      this.changed();
    } finally {
      this.localUpdating = false;
    }
  }

  cancelLocalUpdate(): void { this.cancelLocal = true; }

  /** Poll /api/state until no agent is mid-turn. Returns false if cancelled. Unreachable counts as idle (nothing to protect). */
  private async waitIdle(baseUrl: string, token: string, cancelled: () => boolean, progress: (busy: number) => void): Promise<boolean> {
    while (!cancelled()) {
      let busy = 0;
      try {
        const st = await httpJson<NodeState>(baseUrl, '/api/state', token, 5000);
        busy = st.agents.filter((a) => BUSY.includes(a.status)).length;
      } catch { return true; }
      if (busy === 0) return !cancelled();
      progress(busy);
      await sleep(this.o.idlePollMs ?? 3000);
    }
    return false;
  }
}
