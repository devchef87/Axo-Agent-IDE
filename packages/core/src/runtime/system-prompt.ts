import type { Agent, Project, Team } from '@axo/protocol';

/** Context supplied by the journalist (project map, decisions, live state) and the rotator (handoff). */
export interface PromptExtras {
  projectMap?: string;
  decisions?: string;
  teamBrief?: string;
  stateDoc?: string;
  handoff?: string;
}

export interface PromptContext {
  agent: Agent;
  project: Project;
  team: Team;
  teammates: Agent[];
  hostname: string;
  extras?: PromptExtras;
}

const MAX_PROMPT = 16_000;
const BUDGET = { projectMap: 3500, decisions: 1500, teamBrief: 1200, stateDoc: 5000, handoff: 6000 };

function clip(s: string | undefined, max: number): string {
  if (!s?.trim()) return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) + '\n…(truncated)' : t;
}

// [core2] The axo CLI is on your PATH. Kept short: `axo help` has the rest.
const TEAM_TOOLS = [
  '',
  '## Your team: the `axo` CLI (on your PATH)',
  '- `axo who`: agents you can reach, their teams, status and file scopes.',
  '- `axo ask <agent> "<question>"`: asks and WAITS for the answer (printed to stdout; default limit 110s). Use it when you need the answer before you can continue, e.g. agreeing an interface.',
  '- `axo tell <agent> "<message>"`: sends and returns at once; any reply arrives later as a message. Use it for handoffs and FYIs, or when the other agent is busy.',
  '- Address agents as `name`, `name@team`, or `name@server` for an agent on another of the user\'s servers (relayed by the Axo app; slower, and queued while the app is closed). Do not use your built-in Task/SendMessage tools to reach Axo agents: they cannot see them.',
  '- When a teammate asks you something, answer directly in your reply; it is relayed back to them.',
  '- Writing a file inside a teammate\'s scope is blocked by a hook that tells you who owns it. Ask the owner (`axo ask`/`axo tell`) instead of working around it.',
  '- **Long jobs (builds, test suites, training, deploys, anything over ~2 minutes): use `axo watch "<command>" [--label L] [--timeout 2h]`.** It runs detached, survives your turn ending and node restarts, and wakes you with the exit code and the last 4KB of output. Then END YOUR TURN; do not sleep or poll. A job you start yourself with `&` or `nohup` dies with your turn.',
  '- To wait for something already running: `axo watch --until "<check that exits 0 when ready>"`.',
  '- Recurring reminders: `axo watch --cron "0 9 * * 1-5" --message "<what to do>"` (or `--every 2h`) sends you that message on schedule, even while you are asleep.',
  '- `axo status` shows your identity, team, scope and active watches.',
];

/**
 * Introducer, phase-1 edition: identity + working rules. Phase 3 adds the
 * project map, team brief, decisions and the agent's live state doc.
 */
export function buildSystemPrompt(c: PromptContext): string {
  const { agent, project, team } = c;
  const lines: string[] = [];

  lines.push(`# Axo agent context`);
  lines.push('');
  lines.push(`You are **${agent.name}** (role: ${agent.role}), an agent managed by Axo on host \`${c.hostname}\`.`);
  lines.push(`Project: **${project.name}** at \`${project.path}\``);
  lines.push(`Team: **${team.name}**. Your working directory: \`${agent.workdir}\`${team.branch ? ` (git branch \`${team.branch}\`)` : ''}.`);
  if (agent.scopeGlobs.length) {
    lines.push(`Your file scope: ${agent.scopeGlobs.map((g) => `\`${g}\``).join(', ')} (relative to your working directory). Stay inside it.`);
  }
  if (team.mode === 'worktree') {
    lines.push(`Your team works in its own git worktree on branch \`${team.branch}\`. Commit there; do not edit the main checkout at \`${project.path}\`.`);
  }

  const mates = c.teammates.filter((a) => a.id !== agent.id);
  if (mates.length) {
    lines.push('');
    lines.push('## Teammates');
    for (const m of mates) {
      lines.push(`- **${m.name}** (${m.role})${m.scopeGlobs.length ? ` — scope ${m.scopeGlobs.join(', ')}` : ''}`);
    }
  }

  lines.push('');
  lines.push('## How you work in Axo');
  lines.push('- The user talks to you through the Axo app. Messages may also come from teammates, watches, or Axo itself; those are prefixed with `[from <name>]`.');
  lines.push('- Do not use the AskUserQuestion tool — it is unavailable. If you need input, ask in plain text and end your turn.');
  lines.push('- Never block waiting for approval. Make reasonable decisions, state your assumptions, and keep going.');
  lines.push('- Your session persists across turns. Do not restart work you already did.');
  lines.push(...TEAM_TOOLS);

  if (agent.instructions.trim()) {
    lines.push('');
    lines.push('## Standing instructions from the user');
    lines.push(agent.instructions.trim());
  }

  const x = c.extras ?? {};
  const map = clip(x.projectMap, BUDGET.projectMap);
  const decisions = clip(x.decisions, BUDGET.decisions);
  const brief = clip(x.teamBrief, BUDGET.teamBrief);
  const state = clip(x.stateDoc, BUDGET.stateDoc);
  const handoff = clip(x.handoff, BUDGET.handoff);
  if (map || decisions || brief) {
    lines.push('');
    lines.push('## Project context (maintained by the Axo journalist — trust it, verify details in code when it matters)');
    if (brief) lines.push('', '### Team brief', brief);
    if (map) lines.push('', '### Project map', map);
    if (decisions) lines.push('', '### Recent decisions', decisions);
  }
  if (state) {
    lines.push('');
    lines.push('## Your working state (from your previous session — this is YOUR work, continue it)');
    lines.push(state);
  }
  if (handoff) {
    lines.push('');
    lines.push('## Handoff');
    lines.push('Your context was refreshed to keep you sharp. The user did not see a break; do not mention it or re-introduce yourself. Continue exactly where this leaves off.');
    lines.push('', handoff);
  }

  const out = lines.join('\n');
  return out.length > MAX_PROMPT ? out.slice(0, MAX_PROMPT) : out;
}
