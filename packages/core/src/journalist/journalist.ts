import type { Agent, Project } from '@axo/protocol';
import type { Store } from '../store/db.ts';
import type { EventBus } from '../events.ts';
import type { AgentRuntime, TurnEndEvent } from '../runtime/agent-runtime.ts';
import type { PromptExtras } from '../runtime/system-prompt.ts';
import type { Headless } from './headless.ts';
import { ContextFiles, gitSummary } from './files.ts';
import { recentExchanges, renderTranscript } from './transcript.ts';

export interface JournalistOptions {
  debounceMs?: number;      // after a turn ends, wait this long before updating the state doc
  mapIntervalMs?: number;   // how often dirty projects get their map/decisions refreshed
  model?: string;
  dailyBudgetUsd?: number;  // stop LLM updates past this (state docs fall back to last good)
}

const STATE_SECTIONS = ['Mission', 'Plan', 'Now', 'Decisions', 'Files', 'Open threads', 'User instructions'];

export const STATE_SYSTEM = `You maintain the working-state document for an AI coding agent, so that a fresh replacement agent can continue its work seamlessly with zero loss of context. You receive the previous document and a transcript of the agent's latest activity.

Output ONLY the updated document, in markdown, with exactly these sections in this order:
${STATE_SECTIONS.map((s) => `## ${s}`).join('\n')}

Rules:
- Mission: what the user wants overall. Quote the user's own words for requirements.
- Plan: numbered steps with [x] done / [ ] not done. Keep it current; add steps the agent committed to.
- Now: exactly what the agent was doing at the end of the transcript and the precise next action.
- Decisions: choices made and why (one line each). Keep durable ones, drop trivia.
- Files: key files created, changed or relied on, with one-line purpose.
- Open threads: blockers, unanswered questions, pending watches or teammate requests, failing tests.
- User instructions: standing preferences and constraints from the user, verbatim.
- Merge, don't append: remove anything resolved or obsolete. Never invent facts. Under 900 words.`;

export const MAP_SYSTEM = `You maintain a concise project map for a team of AI coding agents working in one repository, plus a decision log. You receive the existing map, the existing decision log, each agent's working-state document, and a git summary.

Output exactly two parts:
=== MAP ===
<markdown, under 700 words: what the project is; how the code is organized (what lives where); current state of each area; who is working on what; conventions agents must follow>
=== NEW DECISIONS ===
<bullet list of decisions found in the state documents that are NOT already in the decision log, one per line as "- <decision> — <reason>". Write "- none" if there are none.>`;

export const HANDOFF_SYSTEM = `You write handoff briefs for AI coding agents. A fresh agent with no memory will take over mid-task and must continue as if nothing happened. You receive the agent's working-state document and the recent session transcript.

Write a brief in markdown with these sections: ## Where things stand, ## Exactly what to do next, ## Watch out for (pitfalls, failed approaches, gotchas discovered), ## Context you will need (files, commands, decisions). Be specific: file paths, function names, commands, error messages. Under 700 words. Never invent facts.`;

/**
 * Keeps every agent's working state, the project map and the decision log
 * current, so new agents start briefed and rotations lose nothing.
 */
export class Journalist {
  private readonly runtime: AgentRuntime;
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly headless: Headless;
  private readonly opts: Required<JournalistOptions>;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly dirtyProjects = new Set<string>();
  private mapTimer: NodeJS.Timeout | null = null;
  private mapRunning = false;
  private readonly onTurn = (e: TurnEndEvent) => this.schedule(e.agentId);

  constructor(runtime: AgentRuntime, store: Store, bus: EventBus, headless: Headless, opts: JournalistOptions = {}) {
    this.runtime = runtime;
    this.store = store;
    this.bus = bus;
    this.headless = headless;
    this.opts = { debounceMs: 20_000, mapIntervalMs: 10 * 60_000, model: 'haiku', dailyBudgetUsd: 10, ...opts };
  }

  start(): void {
    this.runtime.on('turn-end', this.onTurn);
    this.runtime.setContextProvider((a) => this.contextFor(a));
    this.mapTimer = setInterval(() => void this.refreshMaps(), this.opts.mapIntervalMs);
    this.mapTimer.unref();
  }

  stop(): void {
    this.runtime.off('turn-end', this.onTurn);
    if (this.mapTimer) clearInterval(this.mapTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ── context for system prompts ──────────────────────────

  contextFor(a: Agent): PromptExtras {
    const project = this.store.getProject(a.projectId);
    if (!project) return {};
    const f = new ContextFiles(project);
    const team = this.store.getTeam(a.teamId);
    return {
      projectMap: f.read(f.mapPath),
      decisions: lastLines(f.read(f.decisionsPath), 40),
      teamBrief: team ? f.read(f.teamBriefPath(team.name)) : '',
      stateDoc: f.readState(a.name).text,
    };
  }

  readState(a: Agent): { text: string; updatedAt: number } {
    const project = this.store.getProject(a.projectId);
    if (!project) return { text: '', updatedAt: 0 };
    const s = new ContextFiles(project).readState(a.name);
    return { text: s.text, updatedAt: s.mtime };
  }

  /** User edits to the state doc take effect on the agent's next spawn/rotation. */
  writeStateManual(a: Agent, text: string): void {
    const project = this.store.getProject(a.projectId);
    if (!project) return;
    const f = ContextFiles.ensure(project);
    f.writeState(a.name, text, f.readState(a.name).cursor);
    this.bus.publish({ type: 'journalist:updated', projectId: project.id, agentId: a.id, doc: 'state' });
  }

  projectContext(project: Project): { map: string; decisions: string } {
    const f = new ContextFiles(project);
    return { map: f.read(f.mapPath), decisions: f.read(f.decisionsPath) };
  }

  renameAgent(a: Agent, from: string): void {
    const project = this.store.getProject(a.projectId);
    if (project) new ContextFiles(project).renameState(from, a.name);
  }

  // ── state docs ──────────────────────────────────────────

  schedule(agentId: string): void {
    const t = this.timers.get(agentId);
    if (t) clearTimeout(t);
    this.timers.set(agentId, setTimeout(() => {
      this.timers.delete(agentId);
      void this.updateState(agentId);
    }, this.opts.debounceMs));
  }

  /** Bring the state doc fully up to date now (used before rotations). */
  async flush(agentId: string): Promise<void> {
    const t = this.timers.get(agentId);
    if (t) { clearTimeout(t); this.timers.delete(agentId); }
    await this.updateState(agentId);
  }

  /** Serialized per agent so concurrent triggers never race on the same file. */
  updateState(agentId: string): Promise<void> {
    const prev = this.chains.get(agentId) ?? Promise.resolve();
    const next = prev.then(() => this.doUpdate(agentId)).catch((e) => {
      console.error(`[journalist] state update failed for ${agentId}:`, e?.message ?? e);
    });
    this.chains.set(agentId, next);
    return next;
  }

  private async doUpdate(agentId: string): Promise<void> {
    let a: Agent;
    try { a = this.runtime.get(agentId); } catch { return; }
    const project = this.store.getProject(a.projectId);
    if (!project) return;
    const files = ContextFiles.ensure(project);
    const prev = files.readState(a.name);
    const items = this.runtime.feedSince(agentId, prev.cursor, 600);
    const meaningful = items.filter((i) => i.kind === 'user' || i.kind === 'text' || i.kind === 'tool');
    if (!meaningful.length) return;
    if (this.headless.spentToday >= this.opts.dailyBudgetUsd) return;

    const cursor = Math.max(...items.map((i) => i.ts));
    const prompt = [
      `Agent: ${a.name} (role: ${a.role}) in project "${project.name}" (${project.path}), working directory ${a.workdir}.`,
      '',
      '# Previous working-state document',
      prev.text.trim() || '(none yet; this is the agent\'s first update)',
      '',
      '# Latest activity transcript',
      renderTranscript(items, 16_000),
    ].join('\n');

    const { text } = await this.headless.run({ system: STATE_SYSTEM, prompt, model: this.opts.model });
    const doc = text.trim();
    // Reject malformed output rather than overwrite a good doc.
    if (!doc.includes('## Mission') || !doc.includes('## Now')) {
      console.error(`[journalist] rejected malformed state doc for ${a.name}`);
      return;
    }
    files.writeState(a.name, doc, cursor);
    this.dirtyProjects.add(project.id);
    this.bus.publish({ type: 'journalist:updated', projectId: project.id, agentId, doc: 'state' });
  }

  // ── project map + decisions ─────────────────────────────

  async refreshMaps(force = false): Promise<void> {
    if (this.mapRunning) return;
    this.mapRunning = true;
    try {
      const ids = force ? this.store.listProjects().map((p) => p.id) : [...this.dirtyProjects];
      for (const id of ids) {
        this.dirtyProjects.delete(id);
        const project = this.store.getProject(id);
        if (project) await this.refreshMap(project).catch((e) => console.error('[journalist] map refresh failed:', e?.message ?? e));
      }
    } finally {
      this.mapRunning = false;
    }
  }

  async refreshMap(project: Project): Promise<void> {
    if (this.headless.spentToday >= this.opts.dailyBudgetUsd) return;
    const files = ContextFiles.ensure(project);
    const agents = this.runtime.list().filter((a) => a.projectId === project.id);
    const states = agents
      .map((a) => ({ a, s: files.readState(a.name).text }))
      .filter((x) => x.s.trim())
      .map((x) => `### ${x.a.name} (${x.a.role}, team ${this.store.getTeam(x.a.teamId)?.name ?? '?'})\n${clip(x.s, 4000)}`);
    if (!states.length) return;

    const prevMap = files.read(files.mapPath);
    const decisions = files.read(files.decisionsPath);
    const prompt = [
      `Project: ${project.name} at ${project.path}`,
      '', '# Existing map', prevMap.trim() || '(none yet)',
      '', '# Existing decision log', lastLines(decisions, 80) || '(empty)',
      '', '# Agent working-state documents', states.join('\n\n'),
      '', '# Git summary', gitSummary(project.path) || '(not a git repo)',
    ].join('\n');

    const { text } = await this.headless.run({ system: MAP_SYSTEM, prompt, model: this.opts.model });
    const m = /=== MAP ===\s*([\s\S]*?)\s*=== NEW DECISIONS ===\s*([\s\S]*)$/.exec(text);
    if (!m) { console.error('[journalist] rejected malformed map output'); return; }
    const map = m[1].trim();
    if (map.length > 50) files.write(files.mapPath, `# ${project.name} — project map\n\n_Maintained by the Axo journalist. Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}._\n\n${map.replace(/^# .*\n+/, '')}`);
    const fresh = m[2].split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ') && !/^- none\b/i.test(l));
    if (fresh.length) {
      const header = decisions.trim() ? '' : `# ${project.name} — decision log\n`;
      files.append(files.decisionsPath, `${header}\n## ${new Date().toISOString().slice(0, 10)}\n${fresh.join('\n')}\n`);
    }
    this.bus.publish({ type: 'journalist:updated', projectId: project.id, agentId: null, doc: 'map' });
  }

  // ── handoffs ────────────────────────────────────────────

  /** Journalist-written handoff (used when the agent itself is degraded, or on manual refresh). */
  async handoffBrief(a: Agent, opts: { note?: string; transcriptChars?: number } = {}): Promise<string> {
    const project = this.store.getProject(a.projectId);
    if (!project) throw new Error('project missing');
    const files = new ContextFiles(project);
    const state = files.readState(a.name).text;
    const items = this.runtime.feedSince(a.id, 0, 800);
    const prompt = [
      `Agent: ${a.name} (role: ${a.role}), working directory ${a.workdir}.`,
      opts.note ? `\nThe user refreshed this agent and said: "${opts.note}". Make sure the brief addresses it.` : '',
      '', '# Working-state document', state.trim() || '(none)',
      '', '# Recent session transcript', renderTranscript(items, opts.transcriptChars ?? 30_000),
    ].join('\n');
    const { text } = await this.headless.run({ system: HANDOFF_SYSTEM, prompt, model: this.opts.model });
    return text.trim();
  }

  recentExchanges(a: Agent, n = 6): string {
    return recentExchanges(this.runtime.feedSince(a.id, 0, 400), n);
  }

  saveHandoff(a: Agent, generation: number, text: string): void {
    const project = this.store.getProject(a.projectId);
    if (project) ContextFiles.ensure(project).writeHandoff(a.name, generation, text);
  }
}

function lastLines(s: string, n: number): string {
  const lines = s.trim().split('\n');
  return lines.length > n ? lines.slice(-n).join('\n') : s.trim();
}
function clip(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '\n…' : s; }
