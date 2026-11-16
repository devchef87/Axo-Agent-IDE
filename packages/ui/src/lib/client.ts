import type { EventEnvelope, EventsPage, NodeState } from '@axo/protocol';
import type { NodeConn } from './bridge.ts';

export type ConnStatus = 'connecting' | 'online' | 'offline' | 'unauthorized';

export interface ClientHandlers {
  onState(state: NodeState): void;
  onEvent(ev: EventEnvelope): void;
  onStatus(status: ConnStatus, error?: string): void;
}

/**
 * One connection to one Axo node. Keeps a WebSocket open with backoff, and on
 * every (re)connect replays missed events via /events?since — or refetches
 * full state if the node restarted or the gap is too large.
 */
export class NodeClient {
  readonly conn: NodeConn;
  private ws: WebSocket | null = null;
  private seq = 0;
  private epoch = 0;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly h: ClientHandlers;

  constructor(conn: NodeConn, handlers: ClientHandlers) {
    this.conn = conn;
    this.h = handlers;
  }

  async api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.conn.baseUrl}/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.conn.token}`, ...(init.headers ?? {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return body as T;
  }
  get<T = any>(path: string) { return this.api<T>(path); }
  post<T = any>(path: string, body?: unknown) { return this.api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }); }
  patch<T = any>(path: string, body: unknown) { return this.api<T>(path, { method: 'PATCH', body: JSON.stringify(body) }); }
  del<T = any>(path: string) { return this.api<T>(path, { method: 'DELETE' }); }

  start(): void {
    this.closed = false;
    void this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.h.onStatus('connecting');
    try {
      if (this.seq === 0) await this.loadState();
      else {
        const page = await this.get<EventsPage>(`/events?since=${this.seq}&epoch=${this.epoch}`);
        if (page.reset) await this.loadState();
        else for (const e of page.events) this.handle(e);
      }
    } catch (e: any) {
      if (/unauthorized/i.test(e?.message)) { this.h.onStatus('unauthorized', e.message); return; }
      return this.scheduleReconnect(e?.message);
    }

    const url = this.conn.baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(this.conn.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.h.onStatus('online'); };
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data as string) as EventEnvelope;
      if (ev.type === 'hello') {
        // Close the gap between the REST replay above and this socket opening.
        if (ev.epoch !== this.epoch) void this.loadState();
        else if (ev.seq > this.seq) void this.catchUp();
        return;
      }
      this.handle(ev);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
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
    if (ev.type !== 'agent:text-delta') {
      if (ev.seq <= this.seq) return; // already applied (replay overlap)
    }
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
