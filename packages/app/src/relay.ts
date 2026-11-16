// Cross-server InnerChat (`axo ask bob@prod-1`). Nodes never talk to each other: each
// keeps an outbox; the app reads it, delivers to the target node's relay-in and acks on
// the origin. Answers are envelopes in the target's outbox and travel back the same way.
// Node side + types: core innerchat (RelayEnvelope / RelayInReq / RelayAckReq).

/** The fields the relay needs; the full RelayEnvelope passes through untouched. */
interface Envelope { id: string; toServer: string }
interface Ack { ok: boolean; error?: string }

export interface RelayEndpoint {
  id: string;          // alias the other side sees as fromServer ('local' for this Mac)
  name: string;        // display name, also accepted as an alias
  baseUrl: string;
  token: string;       // node token (agent tokens can't use the relay routes)
  connected: boolean;
}

const PEERS_REFRESH_MS = 60_000;

type Resolved = { target: RelayEndpoint } | { wait: true } | { error: string };

/** toServer → endpoint: ids first, then display names, case-insensitive. */
export function resolveServer(alias: string, all: RelayEndpoint[]): Resolved {
  const a = alias.trim().toLowerCase();
  const byId = all.find((e) => e.id.toLowerCase() === a);
  const byName = byId ? [byId] : all.filter((e) => e.name.toLowerCase() === a);
  const known = all.map((e) => e.id).join(', ');
  if (byName.length > 1) return { error: `server name "${alias}" is ambiguous; use one of: ${byName.map((e) => e.id).join(', ')}` };
  const t = byName[0];
  if (!t) return { error: `no server named ${alias}; known: ${known}` };
  return t.connected ? { target: t } : { wait: true }; // known but offline: keep it in the outbox
}

async function req(e: RelayEndpoint, path: string, body?: unknown, method?: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${e.baseUrl}/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${e.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

export class InnerChatRelay {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Delivered (or definitively rejected) but not yet acked: retry the ack, never the delivery. */
  private readonly pendingAcks = new Map<string, Ack>();
  /** Per node: the peers list last pushed and when. Re-pushed on change, on reconnect, and every minute
   *  (a node restarted behind a live tunnel forgets its list). */
  private readonly pushed = new Map<string, { sig: string; at: number }>();
  private readonly endpoints: () => RelayEndpoint[];
  private readonly log: (m: string) => void;

  constructor(endpoints: () => RelayEndpoint[], log: (m: string) => void = () => {}) {
    this.endpoints = endpoints;
    this.log = log;
  }

  start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Also call right after a node (re)connects. Overlapping calls are skipped. */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const all = this.endpoints();
      await this.pushPeers(all);
      for (const origin of all) {
        if (!origin.connected) continue;
        let outbox: Envelope[];
        try {
          const r = await req(origin, '/innerchat/outbox');
          if (r.status !== 200 || !Array.isArray(r.body)) continue; // offline, or a node from before the relay existed
          outbox = r.body;
        } catch { continue; }
        for (const env of outbox) await this.relayOne(origin, env, all);
      }
      // Bounded: anything left here belongs to an origin that went away; its node expires the entry.
      if (this.pendingAcks.size > 1000) this.pendingAcks.clear();
    } finally {
      this.running = false;
    }
  }

  /** PUT /innerchat/peers so agents can see servers in `axo who` and bad @names fail fast. */
  private async pushPeers(all: RelayEndpoint[]): Promise<void> {
    const servers = all.map(({ id, name, connected }) => ({ id, name, connected }));
    const sig = JSON.stringify(servers);
    const now = Date.now();
    for (const e of all) {
      if (!e.connected) { this.pushed.delete(e.id); continue; } // forces a push after it reconnects
      const last = this.pushed.get(e.id);
      if (last && last.sig === sig && now - last.at < PEERS_REFRESH_MS) continue;
      try {
        const r = await req(e, '/innerchat/peers', { servers }, 'PUT');
        if (r.status < 500) this.pushed.set(e.id, { sig, at: now }); // 404: older node without the route; don't hammer it
      } catch { /* unreachable; next round */ }
    }
  }

  private async relayOne(origin: RelayEndpoint, env: Envelope, all: RelayEndpoint[]): Promise<void> {
    const key = `${origin.id}:${env.id}`;
    let ack = this.pendingAcks.get(key);
    if (!ack) {
      const t = resolveServer(String(env.toServer ?? ''), all);
      if ('wait' in t) return;
      if ('error' in t) ack = { ok: false, error: t.error };
      else {
        try {
          const r = await req(t.target, '/innerchat/relay-in', { envelope: env, fromServer: origin.id });
          if (r.status === 200) ack = { ok: true };
          else if (r.status >= 400 && r.status < 500) ack = { ok: false, error: String(r.body?.error ?? `HTTP ${r.status}`) };
          else return; // target hiccup: leave it pending, try again next round
        } catch { return; } // target unreachable right now
      }
      this.pendingAcks.set(key, ack);
      if (!ack.ok) this.log(`relay ${env.id} ${origin.id} → ${env.toServer}: ${ack.error}`);
    }
    try {
      const r = await req(origin, `/innerchat/outbox/${encodeURIComponent(env.id)}/ack`, ack);
      if (r.status < 500) this.pendingAcks.delete(key);
    } catch { /* origin dropped; retry the ack next round */ }
  }
}
