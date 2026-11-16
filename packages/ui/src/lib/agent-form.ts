// Pure helpers for the agent drawer (unit-tested).
import type { Agent, UpdateAgentReq } from '@axo/protocol';

export interface Form { name: string; model: string; effort: string; instructions: string; scope: string }

export const toForm = (a: Agent): Form => ({
  name: a.name, model: a.model, effort: a.effort ?? '', instructions: a.instructions, scope: a.scopeGlobs.join('\n'),
});

/** Only the fields that changed, in the PATCH /agents/:id shape. */
export function diffAgent(a: Agent, f: Form): UpdateAgentReq {
  const out: UpdateAgentReq = {};
  const name = f.name.trim();
  if (name !== a.name) out.name = name;
  if (f.model !== a.model) out.model = f.model;
  if ((f.effort || null) !== a.effort) out.effort = f.effort || null;
  if (f.instructions !== a.instructions) out.instructions = f.instructions;
  const scope = f.scope.split('\n').map((s) => s.trim()).filter(Boolean);
  if (scope.join('\n') !== a.scopeGlobs.join('\n')) out.scopeGlobs = scope;
  return out;
}

export function formatAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}
