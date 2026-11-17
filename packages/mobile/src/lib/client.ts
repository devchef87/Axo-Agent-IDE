import type { EventEnvelope, EventsPage, NodeState } from '@axo/protocol';
import type { PairedNode } from './pairing.ts';

export type ConnStatus = 'connecting' | 'online' | 'offline' | 'unauthorized';

export interface ClientHandlers {
  onState(state: NodeState): void;
  onEvent(ev: EventEnvelope): void;
  onStatus(status: ConnStatus, error?: string): void;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const REQUEST_TIMEOUT = 15_000;
const PING_EVERY = 25_000;

/**
 * One connection to one Axo node, ported from the desktop client (packages/ui/src/lib/client.ts).
 * Keeps a WebSocket open with backoff; on every (re)connect replays missed events via
 * /events?since, or refetches state when the node restarted or the gap is too large.
 * Phones sleep and switch networks, so `wake()` reconnects immediately when the app returns
 * to the foreground, and a periodic probe catches sockets that died without a close event.
 */
export class NodeClient {
  readonly node: PairedNode;
  private ws: WebSocket | null = null;
  private seq = 0;
  private epoch = 0;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private probe: ReturnType<typeof setInterval> | null = null;
  private lastMessage = 0;
  private closed = false;
  private connecting = false;
  private readonly h: ClientHandlers;

  constructor(node: PairedNode, handlers: ClientHandlers) {
    this.node = node;
    this.h = handlers;
  }

  async api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT);
    try {
      const res = await fetch(`${this.node.url}/api${path}`, {
        ...init,
        signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.node.token}`, ...(init.headers ?? {}) },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new HttpError(res.status, body?.error ?? `HTTP ${res.status}`);
      return body as T;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('timed out');
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
  get<T = any>(path: string) { return this.api<T>(path); }
  post<T = any>(path: string, body?: unknown) { return this.api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }); }

  start(): void {
    this.closed = false;
    void this.connect();
    this.probe = setInterval(() => this.check(), PING_EVERY);
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.probe) clearInterval(this.probe);
    this.timer = null;
    this.probe = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  /** App came back to the foreground (or the network changed): reconnect now instead of waiting out the backoff. */
  wake(): void {
    if (this.closed) return;
    this.retry = 0;
    if (this.ws?.readyState === WebSocket.OPEN) { void this.catchUp().catch(() => this.drop()); return; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    void this.connect();
  }

  /** The socket is open but nothing has arrived for a while: confirm the node is still there. */
  private check(): void {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastMessage < PING_EVERY) return;
    this.get('/version').then(() => { this.lastMessage = Date.now(); }, () => this.drop());
  }

  private drop(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.scheduleReconnect('connection lost');
  }

  private async connect(): Promise<void> {
    if (this.closed || this.connecting) return;
    this.connecting = true;
    this.h.onStatus('connecting');
    try {
      if (this.seq === 0) await this.loadState();
      else await this.catchUp();
    } catch (e: any) {
      this.connecting = false;
      if (e instanceof HttpError && e.status === 401) { this.h.onStatus('unauthorized', 'This phone was unpaired from the server.'); return; }
      return this.scheduleReconnect(e?.message);
    }
    this.connecting = false;
    if (this.closed) return;

    const old = this.ws;
    this.ws = null;
    old?.close();
    const url = this.node.url.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(this.node.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.lastMessage = Date.now(); this.h.onStatus('online'); };
    ws.onmessage = (m) => {
      if (this.ws !== ws) return;
      this.lastMessage = Date.now();
      let ev: EventEnvelope;
      try { ev = JSON.parse(m.data as string) as EventEnvelope; } catch { return; }
      if (ev.type === 'hello') {
        // Close the gap between the REST replay above and this socket opening.
        if (ev.epoch !== this.epoch) void this.loadState().catch(() => this.drop());
        else if (ev.seq > this.seq) void this.catchUp().catch(() => this.drop());
        return;
      }
      this.handle(ev);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.scheduleReconnect('connection closed');
    };
  }

  private async catchUp(): Promise<void> {
    const page = await this.get<EventsPage>(`/events?since=${this.seq}&epoch=${this.epoch}`);
    if (page.reset) await this.loadState();
    else for (const e of page.events) this.handle(e);
  }

  private async loadState(): Promise<void> {
    const s = await this.get<NodeState>('/state');
    this.seq = s.seq;
    this.epoch = s.epoch;
    this.h.onState(s);
  }

  private handle(ev: EventEnvelope): void {
    if (ev.type !== 'agent:text-delta' && ev.seq <= this.seq) return; // already applied (replay overlap)
    this.seq = Math.max(this.seq, ev.seq);
    this.h.onEvent(ev);
  }

  private scheduleReconnect(reason?: string): void {
    if (this.closed || this.timer) return;
    this.h.onStatus('offline', reason);
    const delay = Math.min(1000 * 2 ** this.retry, 15_000);
    this.retry++;
    this.timer = setTimeout(() => { this.timer = null; void this.connect(); }, delay);
  }
}
