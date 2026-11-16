// Which node events deserve a macOS notification. Pure (no store, no bridge) so it
// can be unit-tested; lib/notifications.ts feeds it and shows the results.

import type { Agent, AgentStatus, EventEnvelope } from '@axo/protocol';

export interface Notice {
  key: string;              // dedupe key
  title: string;
  body: string;
  nodeKey: string;
  agentId: string | null;   // click target
}

export interface RuleContext {
  nodeName: string;
  /** The agent as the store has it *before* this event is applied. */
  agent(agentId: string): Agent | undefined;
  now: number;
}

const BUSY: AgentStatus[] = ['working', 'starting', 'rotating'];
/** Replayed events older than this (e.g. after the Mac slept) don't notify. */
export const STALE_MS = 5 * 60_000;

interface AgentMemo {
  lastText: string;         // last assistant prose of the current turn
  promptAuthor: string;     // who sent the message that started the turn
  interrupted: boolean;
  isError: boolean;
}

const snippet = (s: string, n = 140) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** A turn that ends with a question to the user: the last paragraph ends with '?'. */
export function lastQuestion(text: string): string | null {
  const paras = text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paras[paras.length - 1] ?? '';
  if (!/\?["')\]*_`]*$/.test(last)) return null;
  // Prefer the final sentence; questions often follow a summary.
  const sentences = last.split(/(?<=[.!?])\s+/);
  return sentences[sentences.length - 1] || last;
}

export class NotifyRules {
  private readonly memo = new Map<string, AgentMemo>(); // `${nodeKey}:${agentId}`, one entry per agent
  private readonly watchSeen = new Set<string>();

  /** Returns a notice to show, or null. Call for every event, before the store applies it. */
  handle(nodeKey: string, ev: EventEnvelope, ctx: RuleContext): Notice | null {
    const fresh = ctx.now - ev.ts < STALE_MS;
    switch (ev.type) {
      case 'agent:feed': {
        const m = this.get(nodeKey, ev.agentId);
        const it = ev.item;
        if (it.kind === 'user') { m.promptAuthor = it.author; m.lastText = ''; m.interrupted = false; m.isError = false; }
        else if (it.kind === 'text') m.lastText = it.text;
        else if (it.kind === 'turn') { m.interrupted = !!it.interrupted; m.isError = it.isError; }
        return null;
      }
      case 'agent:removed':
        this.memo.delete(`${nodeKey}:${ev.agentId}`);
        return null;
      case 'agent:upsert': {
        const before = ctx.agent(ev.agent.id);
        const a = ev.agent;
        if (!before || !BUSY.includes(before.status) || BUSY.includes(a.status) || !fresh) return null;
        if (before.status === 'rotating') return null; // end of a context refresh, not of a turn (that one already notified)
        if (a.queued > 0) return null; // more work already lined up
        const m = this.get(nodeKey, a.id);
        if (m.interrupted) return null; // the user stopped it
        const where = ctx.nodeName === 'Local' ? '' : ` · ${ctx.nodeName}`;
        if (a.status === 'error' || m.isError) {
          return { key: `err:${nodeKey}:${a.id}:${ev.seq}`, title: `${a.name} stopped with an error${where}`, body: snippet(a.lastError ?? m.lastText ?? 'See the chat for details.'), nodeKey, agentId: a.id };
        }
        if (a.status !== 'idle') return null;
        // A reply to another agent's InnerChat message isn't something the user is waiting on.
        if (m.promptAuthor && !['user', 'watch', 'axo'].includes(m.promptAuthor)) return null;
        const q = lastQuestion(m.lastText);
        if (q) return { key: `q:${nodeKey}:${a.id}:${ev.seq}`, title: `${a.name} has a question${where}`, body: snippet(q), nodeKey, agentId: a.id };
        return { key: `done:${nodeKey}:${a.id}:${ev.seq}`, title: `${a.name} finished${where}`, body: m.lastText ? snippet(m.lastText) : 'Waiting for your next message.', nodeKey, agentId: a.id };
      }
      case 'watch:upsert': {
        const w = ev.watch;
        if (w.status === 'active' || !w.result || this.watchSeen.has(w.id)) return null;
        this.watchSeen.add(w.id);
        if (this.watchSeen.size > 500) this.watchSeen.delete(this.watchSeen.values().next().value!);
        if (!fresh || w.status === 'cancelled') return null;
        const ok = w.result.outcome === 'success';
        return {
          key: `watch:${nodeKey}:${w.id}`,
          title: `Watch ${ok ? 'done' : w.result.outcome === 'timeout' ? 'timed out' : 'failed'}: ${w.label}`,
          body: snippet([w.agentName, w.result.summary].filter(Boolean).join(' · ') || w.command),
          nodeKey, agentId: w.agentId,
        };
      }
      case 'rotation:aborted': {
        if (!fresh) return null;
        const a = ctx.agent(ev.agentId);
        return { key: `rot:${nodeKey}:${ev.agentId}:${ev.seq}`, title: `Context refresh aborted${a ? `: ${a.name}` : ''}`, body: snippet(ev.reason), nodeKey, agentId: ev.agentId };
      }
      default:
        return null;
    }
  }

  private get(nodeKey: string, agentId: string): AgentMemo {
    const k = `${nodeKey}:${agentId}`;
    let m = this.memo.get(k);
    if (!m) { m = { lastText: '', promptAuthor: '', interrupted: false, isError: false }; this.memo.set(k, m); }
    return m;
  }
}
