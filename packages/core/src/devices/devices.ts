import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import type { CreatedDevice, Device, TailscaleSettings } from '@axo/protocol';
import type { Store } from '../store/db.ts';
import { ulid } from '../util/ulid.ts';
import { HttpError } from '../util/http-error.ts';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
type Row = Record<string, any>;
const toDevice = (r: Row): Device => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeenAt: r.last_seen_at ?? null });

/** Per-phone tokens. Only hashes are stored; the token is returned once, at creation. Emits 'revoked' (id). */
export class Devices extends EventEmitter {
  private readonly store: Store;
  private readonly seen = new Map<string, number>(); // id → last write, to throttle last_seen_at updates

  constructor(store: Store) { super(); this.store = store; }

  create(name: string, url: string | null): CreatedDevice {
    const n = String(name ?? '').trim().slice(0, 80);
    if (!n) throw new HttpError(400, 'name required');
    const token = `axd_${randomBytes(24).toString('base64url')}`;
    const d: Device = { id: ulid(), name: n, createdAt: Date.now(), lastSeenAt: null };
    this.store.db.prepare('INSERT INTO devices (id, name, token_hash, created_at) VALUES (?,?,?,?)').run(d.id, d.name, hash(token), d.createdAt);
    return { ...d, token, url };
  }

  list(): Device[] {
    return (this.store.db.prepare('SELECT * FROM devices ORDER BY created_at').all() as Row[]).map(toDevice);
  }

  revoke(id: string): void {
    const r = this.store.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    if (!r.changes) throw new HttpError(404, 'No such device');
    this.emit('revoked', id);
  }

  /** Device id for a token, or null. */
  verify(token: string): string | null {
    if (!token.startsWith('axd_')) return null;
    const row = this.store.db.prepare('SELECT id FROM devices WHERE token_hash = ?').get(hash(token)) as Row | undefined;
    if (!row) return null;
    const now = Date.now();
    if (now - (this.seen.get(row.id) ?? 0) > 60_000) {
      this.seen.set(row.id, now);
      this.store.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    }
    return row.id;
  }
}

/** This machine's Tailscale IPv4 (100.64.0.0/10), or null. */
export function tailscaleAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      if (x === 100 && y >= 64 && y <= 127) return a.address;
    }
  }
  return null;
}

/**
 * Opt-in second listener on the Tailscale address, so a paired phone can reach this node without the desktop.
 * Requests are handed to the main server marked external: agent tokens and terminals are refused there.
 * Persisted in ~/.axo/settings.json; re-checks the address every 30s (Tailscale may come up after us).
 */
export class TailscaleListener {
  private readonly file: string;
  private enabled: boolean;
  private server: Server | null = null;
  private address: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private main: Server | null = null;

  private readonly port: () => number;
  private readonly findAddress: () => string | null;

  constructor(home: string, port: () => number, findAddress: () => string | null = tailscaleAddress) {
    this.port = port;
    this.findAddress = findAddress;
    this.file = join(home, 'settings.json');
    this.enabled = process.env.AXO_LISTEN_TAILSCALE === '1' || this.read().listenTailscale === true;
  }

  start(main: Server): void {
    this.main = main;
    this.sync();
    this.timer = setInterval(() => this.sync(), 30_000);
    this.timer.unref();
  }

  settings(): TailscaleSettings {
    const url = this.server && this.address ? `http://${this.address}:${this.port()}` : null;
    return { enabled: this.enabled, address: this.findAddress(), url };
  }

  async set(enabled: boolean): Promise<TailscaleSettings> {
    this.enabled = !!enabled;
    writeFileSync(this.file, JSON.stringify({ ...this.read(), listenTailscale: this.enabled }, null, 2));
    await this.sync();
    return this.settings();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.close();
  }

  private read(): Record<string, unknown> {
    try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {}; } catch { return {}; }
  }

  private async sync(): Promise<void> {
    if (!this.main) return;
    const want = this.enabled ? this.findAddress() : null;
    if (want === this.address && (!!this.server === !!want)) return;
    await this.close();
    if (!want) return;
    const main = this.main;
    const s = createServer((req, res) => { (req as any).axoExternal = true; main.emit('request', req, res); });
    s.on('upgrade', (req, sock, head) => { (req as any).axoExternal = true; main.emit('upgrade', req, sock, head); });
    await new Promise<void>((res) => {
      s.once('error', (e) => { console.warn('[axo-node] tailscale listener:', (e as Error).message); res(); });
      s.listen(this.port(), want, () => { this.server = s; this.address = want; console.log(`[axo-node] also listening on http://${want}:${this.port()} (Tailscale)`); res(); });
    });
  }

  private close(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.address = null;
    if (!s) return Promise.resolve();
    return new Promise((res) => { s.close(() => res()); s.closeAllConnections(); });
  }
}
