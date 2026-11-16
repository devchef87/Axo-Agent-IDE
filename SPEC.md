# Axo — Spec v0.1

> A lightweight agent OS for running teams of Claude Code agents across my machine and my servers.
> Successor to Groove, built for one user and Claude only.
> Status: **DRAFT for review**, 2026-11-16

---

## 1. Principles

1. **Claude Code only.** No other providers, no local models, no model routing. We drive the `claude` CLI and rely on its own features (hooks, skills, subagents, MCP, compaction) instead of rebuilding them.
2. **The process can die; the session can't.** A `claude` process can be killed or crash at any time. The agent's identity, conversation (Claude session ID) and working state live on disk, and `--resume` brings everything back.
3. **Stable identity.** An agent's ID never changes: not on resume, not on rotation, not on restart. (Groove's ID churn caused most of its state bugs.)
4. **Rotation is invisible.** A rotation must never lose the agent's map, plan or context. If the replacement can't prove it is caught up, the rotation is cancelled.
5. **Remote is built in from day one.** The local machine is just another node. The UI talks to every node, including the local one, through the same protocol.
6. **Bounded data.** Every log, history and ledger has a size limit or rotates. No 24MB JSON files.
7. **Agents run with full permissions** (`--permission-mode bypassPermissions`). Coordination is enforced through hooks, not permission prompts.
8. **Don't touch user files.** Axo never writes into the user's `CLAUDE.md` or `.gitignore`. Context goes in through the system prompt, and Axo files live under `.axo/`, excluded from git via `.git/info/exclude`.

## 2. Non-goals (cut from Groove)

- **Providers and models:** Codex, Gemini, Grok, Ollama/local, model lab, llama/mlx, the local-model agent loop and tool executor.
- **Remote and outside services:** Axo, federation, the network/wallet features, Slack/Discord/Telegram gateways.
- **Marketplaces:** integrations/MCP marketplace, the paid skills store, repo import.
- **Model guessing and gates:** router, classifier, adaptive thresholds, PM review gate, task-split negotiation, phase-2 QC auto-spawn, supervisor.
- **Other subsystems:** moe-training / trajectory capture, auto-agents and the orchestrator, the automations wizard, toys, personalities.
- **App shell:** subscription polling, the welcome/splash app, multiple windows.
- Writing into `CLAUDE.md`, `AGENTS_REGISTRY.md` and `coordination.md` files.

(A cron scheduler may come back later as part of Watches; see §10.)

---

## 3. Architecture

```
┌──────────────────────── Axo.app (Electron, macOS) ────────────────────────┐
│  main process                                                             │
│   ├─ NodeManager: spawns local node, opens SSH tunnels to remote nodes    │
│   ├─ Keychain (SSH key passphrases, node tokens), notifications, updater  │
│   └─ hands renderer: [{nodeId, baseUrl, token}]                           │
│  renderer (React UI) ── HTTP + WS ──┬── local node   127.0.0.1:31500      │
│                                     ├── tunnel → prod-1 node              │
│                                     ├── tunnel → staging node             │
│                                     └── tunnel → gpu-box node             │
└───────────────────────────────────────────────────────────────────────────┘

axo-node (same bundle everywhere: macOS locally, Linux on servers)
 ├─ AgentRuntime     long-lived claude processes, delivery queue, turn tracking
 ├─ Teams/Worktrees  git worktree per team, scope locks, knock hook endpoint
 ├─ Journalist       per-agent state docs, project map, decision log (Haiku)
 ├─ Rotator          triggers, hot-swap, verification, refresh/fork
 ├─ InnerChat        ask/tell between agents (+ relay via app for cross-node)
 ├─ Watches          detached jobs that wake agents on completion
 ├─ Keeper           user-owned tagged memory
 ├─ Files/Terminal   file API, fs watch, git status/diff, PTY shells
 └─ Store            SQLite (node:sqlite, no native modules)
```

- **One codebase, two roles.** `packages/core` builds into a single `axo-node.mjs` (esbuild). Locally the app runs it as a **detached background process**, so closing the window does not kill local agents (same as on servers). On each server it runs as a `systemd --user` service.
- **Port:** 31500. This avoids clashing with Groove on 31415, so both can run side by side during migration.
- **Auth:** every node creates `~/.axo/node.token` on first start. Every HTTP and WS request must send `Authorization: Bearer <token>`. Nodes bind to `127.0.0.1` only; remote access is always through an SSH tunnel.

---

## 4. Agent runtime

### 4.1 Process model (verified 2026-11-16, Claude Code 2.1.280)

Each live agent is **one long-lived process**:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --session-id <uuid> | --resume <uuid>        # new session | continue session
  --permission-mode bypassPermissions \
  --append-system-prompt "<introducer output, ≤12KB>" \
  --settings <node>/agents/<id>/settings.json \ # knock PreToolUse hook + env
  --model <model> [--effort <level>]
```

- **Turns are sent on stdin.** One JSONL message per turn: `{"type":"user","message":{"role":"user","content":[...]}}`. The process stays alive between turns. Verified: two turns in one process, memory kept, and our own `--session-id` was used.
- **Turn boundary:** the `result` event. While a turn is running, new messages are **queued**. At the boundary, the queued messages are combined into one turn.
- **Interrupt** (the Stop button / Esc): send a stream-json `control_request` interrupt. **Verified:** you get a `control_response`, then a `result` with subtype `error_during_execution`, and the process stays alive. If it's ignored, after 8s send SIGINT, then SIGKILL; the session resumes.
- **Process death** (crash, node restart, idle reaping): mark the agent `asleep`. The next message spawns it again with `--resume <sessionId>`, under the same agent ID and the same session.
- **Idle reaping:** an agent with no turns for N minutes (default 30) is sent SIGTERM to free RAM. It is resumed transparently on the next message. The process manager also kills any orphaned `claude` processes on startup (lesson learned from Groove's 42 zombie processes).
- **Environment** passed to each agent: `AXO_AGENT_ID`, `AXO_AGENT_NAME`, `AXO_NODE_URL`, `AXO_TOKEN`, and `PATH` with the `axo` CLI on it (CLI in phase 2).
- **Auth:** subscription login by default (`ANTHROPIC_API_KEY` is removed from the environment). On a server, either use an existing `claude login` or set `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.

### 4.2 Parsing the output stream

These events are mapped to agent state and UI events:

| stream-json | Axo |
|---|---|
| `system/init` | `sessionId`, model, tools, cwd |
| `assistant` text / `tool_use` blocks | feed items (structured, not keyword-guessed) |
| `user` `tool_result` blocks | paired with the matching `tool_use` → result, error flag, Edit diffs |
| `assistant.message.usage` | context tokens = input + cache_read + cache_creation |
| `system/compact_boundary` | compaction counter and pre-compaction token count *(verify name)* |
| `result` | turn end: cost, duration, `num_turns`, `is_error` |
| `rate_limit_event` | shown in the status bar |

- Raw stream-json is appended to `~/.axo/logs/<agentId>/<sessionId>.jsonl`. Files rotate at 20MB and only the last 5 are kept. *(Deferred to phase 3; phase 1 keeps the structured feed in SQLite.)*
- `AskUserQuestion` can't work in `-p` mode, so it is disallowed with `--disallowedTools`. The system prompt tells the agent to ask in plain text instead.

### 4.3 States

`asleep` (no process, resumable) → `starting` → `idle` (process up, waiting for input) → `working` (in a turn) → `idle` …
Other states: `rotating`, `error`, `stopped` (user killed it; it stays in the team until deleted).

---

## 5. Data model (SQLite at `~/.axo/axo.db` on each node)

```
projects   id, name, path, git(bool), base_branch, setup_cmd, created_at
teams      id, project_id, name, branch, worktree_path, mode('worktree'|'shared'|'direct'), created_at, archived_at
agents     id(ulid, permanent), team_id, name, role, model, effort, scope_globs(json),
           instructions, status, current_session_id, created_at
sessions   id(claude uuid), agent_id, generation, started_at, ended_at, end_reason,
           tokens_in, tokens_out, cache_read, peak_context, compactions, turns
messages   id, agent_id, session_id, ts, kind(user|assistant|system|innerchat|watch|rotation),
           author, body, meta(json)                 -- the chat timeline (bounded per agent)
tool_calls id, agent_id, session_id, ts, tool, target, summary, is_error, duration_ms
usage      agent_id, session_id, ts, input, output, cache_read, cache_creation, cost_usd
watches    id, agent_id, label, mode, command, until, status, exit_code, created_at, finished_at
threads    innerchat threads (persisted, unlike Groove's in-memory ones)
keeper     tag, path, size, updated_at              -- body lives in .md files
```

Retention: the most recent 5k messages and 20k tool calls per agent. Usage is rolled up into hourly totals after 7 days.

**Files inside each project** (`<project>/.axo/`, git-excluded):

```
.axo/context/map.md              project map (Journalist)
.axo/context/decisions.md        decision log (deduplicated, Journalist)
.axo/context/teams/<team>.md     team brief: goal, members, current state
.axo/state/<agent-name>.md       live working state per agent (Journalist)
.axo/handoffs/<agent-name>/<n>.md   flat handoff ledger, last 10, each ≤ 6KB
.axo/keeper/<tag>.md + index.json
.axo/worktrees/<team-slug>/      team worktrees
```

They live in the project so agents can read them by path and they move with the project.

---

## 6. Teams, worktrees and locks

**A team is one goal with a set of agents.** It has three modes:

| Mode | When | Workdir |
|---|---|---|
| `worktree` (default for git projects) | normal work | `.axo/worktrees/<team>` on branch `axo/<team>`, created from `base_branch` |
| `shared` | team must work on the main checkout (for example, live server config) | project path |
| `direct` | not a git repo | project path |

- **Per-agent worktree** is an option for a risky task running in parallel. The agent gets `.axo/worktrees/<team>--<agent>` and a "merge into team branch" action.
- **Setup command:** `projects.setup_cmd` (for example `npm ci`) runs as a Watch when a worktree is created. The agent is told when it finishes.
- **Merge view:** shows the team branch diff against base, with buttons to merge, rebase or open a PR. You can also ask an agent to do it.

**Scope locks**, fixing Groove's problem with absolute paths:
- Each agent has optional `scope_globs` relative to the team workdir.
- The knock hook (`PreToolUse` on `Write|Edit|MultiEdit|NotebookEdit`) sends `{agentId, tool, paths}` to the node. The node **converts absolute paths to paths relative to the agent's workdir** and then checks two things:
  1. Is the path inside my scope, if I have one?
  2. Is it inside a teammate's scope?
- A denial exits with code 2 and a reason like "src/api/** is owned by backend-1; ask them via `axo ask backend-1`".
- **Failure policy:** if the node can't be reached, the call is allowed and the event is logged. Bash is **not** hooked, which avoids paying a Node startup on every shell call. File tracking for Bash comes from git status instead.
- The hook is a ~30-line script that calls `curl` instead of starting Node.

---

## 7. Context systems

### 7.1 Introducer (briefing at spawn)

The system prompt (`--append-system-prompt`) is built at spawn time and capped at **12KB**. It contains, in this order:
1. Identity: name, role, team, node/server, workdir, branch, scope.
2. Team brief (`teams/<team>.md`) and teammate roster with one-line status each.
3. Project map, summarised to fit the remaining budget.
4. Recent relevant decisions.
5. The agent's own state doc (empty for a new agent; full for a rotation).
6. How to use Axo: `axo ask|tell|who|watch|keeper`, how to run long jobs, and the scope rules.
7. The user's standing instructions (per agent and per project).

The system prompt is fixed for the life of the process. When the team changes mid-session (someone joins or leaves, scopes change), the next turn gets a short `[axo] team update: …` prefix.

### 7.2 Journalist

It runs on Haiku through `claude -p --model haiku`, with `ANTHROPIC_API_KEY` stripped and **cwd set to an empty temp directory** so the user's `CLAUDE.md` and MCP config don't load into it.

- **After every turn**, debounced by 20s per agent and skipped for turns with no tool calls and no new user message: it does an **incremental update** of `.axo/state/<agent>.md`. Input is the previous state doc plus a summary of that turn's user message, assistant text and tool calls (about 4–8K characters). Output is a rewritten state doc with these sections:
  - **Mission**: what the user wants, word for word where it matters
  - **Plan**: steps, with done and not-done marked
  - **Now**: exactly what it was doing and the next action
  - **Decisions**: what was chosen and why
  - **Files**: key files touched or read, and why they matter
  - **Open threads**: blockers, questions, what it is waiting on (watches, InnerChat)
  - **User instructions**: standing preferences, kept word for word
- **Every 10 minutes per project, only if something changed:** update `map.md` (structure, what lives where, current state of each area) from the state docs and `git diff --stat`. Also update `decisions.md` by merging new decisions from the state docs, removing duplicates by meaning, and appending.
- **On demand:** write handoff briefs (§8) and team briefs.
- **Budget guard:** the journalist's token use is tracked as its own line item, with a daily cap (configurable). If it hits the cap, it falls back to state docs built from data alone.

### 7.3 Memory

- **Keeper:** the user's tagged notebook, ported from Groove. Chat commands `[save] #tag`, `[pull] #tag`, and so on are intercepted before they reach the agent. Agents can also read it through `axo keeper read <tag>`. There is a Memory view in the UI.
- **Handoff ledger:** a flat list per agent, never nested, last 10 entries kept, each up to 6KB.
- **Project and team context:** `map.md`, `decisions.md`, `teams/*.md`, maintained by the Journalist.
- Dropped from Groove: discoveries.jsonl, constraints auto-extraction, specializations. They were mostly noise.

---

## 8. Rotation

### 8.1 Triggers

All triggers are checked **only at turn boundaries**, so no turn is ever killed in the middle.

| Trigger | Default | Notes |
|---|---|---|
| Context pressure | context ≥ 85% *and* ≥ 2 compactions this session | Claude Code compacts on its own, so we only step in when compaction keeps repeating |
| Token ceiling | 5M cumulative tokens in the session | very large sessions make `--resume` unstable |
| Velocity spike | 1.5M tokens in 5 min | signals a runaway loop |
| Degradation | at least 2 of the independent signals below | |
| Manual | Refresh / Fork buttons, `axo rotate` | |

**Degradation signals.** These are deliberately independent of each other; Groove's F1 failure came from counting the same cause several times.
- **Loop:** the same tool and the same arguments 4 or more times in the last 15 calls.
- **Output collapse:** median assistant text per turn drops below 15% of the session's baseline over 3 turns.
- **Edit failure streak:** 4 or more consecutive failed Edit/Write calls. Bash or test failures do **not** count; a failing test suite is normal work.
- **Truncation:** a `result` with `is_error`, or a turn that ends in the middle of a tool call, twice in a row.

### 8.2 Hot-swap protocol

1. **Prepare the brief** while the current agent keeps working:
   - **If the agent is healthy** (context or ceiling trigger): at the next turn boundary, give it an **exit-interview** turn. It updates its own state doc and writes a handoff. The agent's own account is the best brief available.
   - **If it is degraded:** the Journalist writes the handoff from the state doc and the last ~30K characters of the conversation.
2. **Warm up the successor:** a new `claude` process (new Claude session, **same agent ID**) is primed in the background with:
   - its system prompt (§7.1), where the state doc carries the full plan and context
   - the handoff brief
   - the last 6 user/assistant exchanges, word for word
   - `git status` and `git diff --stat` of its workdir

   It then runs a hidden warm-up turn: "re-read the files you need, then reply with: current task, next action, and open threads".
3. **Verify:** the Journalist compares the warm-up reply with the state doc's Mission, Now and Open threads, and gives a pass or fail.
   - **Fail:** retry once with a fuller brief. If it fails again, abort, keep the old process, and notify the user.
4. **Swap at the boundary:** queued messages go to the successor and `agents.current_session_id` is updated. Pending InnerChat waits and watches keep pointing at the agent ID, so nothing needs remapping. The old process gets SIGTERM.
5. **In the UI:** a thin "refreshed" divider appears in the chat, collapsed by default. Nothing else changes: same name, same panel, same history.

### 8.3 Manual

- **Refresh** (one click on the agent): runs the hot-swap now, with an optional "what went wrong" note added to the brief.
- **Fork:** creates a new agent in the same team from this agent's state and handoff. The original keeps running.
- **Rewind** (later): resume from an earlier session generation.

---

## 9. InnerChat

Ported from Groove: blocking `ask`, async `tell`, 12-exchange cap per thread, deadlock guard.

Changes from Groove:
- **Threads are stored on disk**, so they survive restarts.
- **Sender identity comes from the environment.** The CLI sends `AXO_AGENT_ID` plus the token, so an agent can no longer claim to be someone else.
- **Addressing:** `name` (same project), `name@team`, or `name@server` (another node, relayed by the app; if the app is offline, the message waits in the sending node's outbox).
- `ask` sits behind Claude's Bash tool, so its timeout stays under the Bash timeout. The CLI prints a hint to switch to `tell` for long waits.
- InnerChat bubbles appear in both agents' feeds.

## 10. Watches

Ported from Groove; it was already clean. A detached `run.sh` writes `out.log` and an `exit` file, gets re-armed when the node restarts, and wakes the agent **by ID** with the exit code and the last 4KB of output.
- **Modes:** `command` (Axo runs it) and `until` (poll a condition).
- **New Watches view:** live list across nodes, tail the output, cancel, re-run.
- **Later:** a `cron` mode ("every day at 9am, send agent X this message"), replacing Groove's automations.

---

## 11. Remote nodes

**Adding a server**, in the Settings → Servers wizard:
1. Pick a host from `~/.ssh/config` or enter host, user, port and key. Key passphrases come from ssh-agent or Keychain. Axo uses the system `ssh` with `ControlMaster`, `ServerAliveInterval 15` and `ExitOnForwardFailure`.
2. **Preflight:** checks the OS, `node ≥ 22.13` (needed for `node:sqlite`), `claude --version`, `claude` auth status, `git`, and free disk space.
3. **Deploy:** `scp axo-node.mjs + axo CLI → ~/.axo/bin/`, then install a `systemd --user` unit (`loginctl enable-linger` if needed; falls back to `nohup` plus a pidfile).
4. **Connect:** read `~/.axo/node.token` over SSH, open `ssh -N -L <freePort>:127.0.0.1:31500`, and register the node in the renderer.

**Lifecycle**
- Tunnel supervisor: reconnects with backoff, and reconnects again when the Mac wakes from sleep. Agents on the server are unaffected throughout.
- On reconnect, the UI calls `GET /events?since=<cursor>` to replay what happened while it was disconnected.
- **Version check:** if the node's version doesn't match the app's, the app offers to update. The update waits until no agents are mid-turn, then restarts the node; agents resume by session (§4.1).
- **Migration from Groove:** Axo runs on its own port and its own `~/.axo/`, so it can run next to Groove on the same server. An optional import pulls Keeper notes and teams in from `.groove/`.

**In the UI**
- The sidebar shows `Local`, `prod-1`, `staging`, … with connection dots.
- Everything else (editor, terminal, watches, memory) is scoped to the node of whatever project you're in.

---

## 12. Protocol between the app and nodes

REST at `/api/*`. One WebSocket at `/ws`. All events carry `{nodeId, seq, ts}`, and `seq` lets the UI replay missed events.

**REST (core):**
- `projects`, `teams`, `agents` CRUD
- `agents/:id/message`, `agents/:id/stop`, `agents/:id/refresh`, `agents/:id/fork`
- `agents/:id/timeline?before=`, `agents/:id/state`
- `innerchat/ask|tell|who`
- `watches`
- `keeper/*`
- `files/*`: tree, read, write, raw, upload, rename, delete, search, git-status, diff
- `knock`
- `events?since=`
- `health`, `version`

**WS events:**
- `agent:upsert`, `agent:status`
- `agent:feed` (structured feed items: text deltas, tool_use, tool_result)
- `agent:turn` (start and end, with usage)
- `agent:usage`
- `rotation:started`, `rotation:verified`, `rotation:completed`, `rotation:aborted`
- `innerchat:turn`
- `watch:*`
- `knock:denied`
- `journalist:updated`
- `team:*`
- `file:changed`, `file:tree-changed`
- `terminal:*`
- `keeper:*`

About 25 event types, against Groove's ~150.

## 13. UI

**Layout:** the One Dark/teal theme from Groove, dense type, dark only.

```
┌ sidebar ──────────┬ main ─────────────────────────────────┬ detail drawer ┐
│ ▾ Local       ●   │ [Fleet] [Editor] [Memory] [Watches]   │ agent: Chat   │
│   ▾ Axo           │                                       │  State  Files │
│     ▾ core-team   │   split chat panes (1–3)              │  Config       │
│       backend-1 ● │                                       │               │
│       ui-1      ● │                                       │               │
│ ▸ prod-1      ●   │                                       │               │
│ ▸ staging     ○   ├───────────────────────────────────────┤               │
│ + server          │ terminal (toggle ⌘J)                  │               │
└───────────────────┴───────────────────────────────────────┴───────────────┘
 status bar: nodes ● ● ○ │ 7 agents working │ tokens today │ watches 2
```

**Views**
- **Fleet (home):** split chat panes. Each feed shows text, grouped tool calls (from structured events, with inline Edit diffs), InnerChat bubbles (indigo), watch results, and rotation dividers.
- **Agent drawer:**
  - **Chat**
  - **State:** the live Journalist doc. You can edit it, and your edits apply on the agent's next turn.
  - **Files:** what this agent touched and the diff
  - **Config:** model, effort, scope, instructions
  - **Actions:** Refresh, Fork, Stop, Delete
- **Editor:** file tree with git status, CodeMirror tabs, media viewer (images, video, **PDF via pdf.js**), HTML preview, diff view, "send selection to agent".
- **Memory:** Keeper tree and cards, plus project map and decisions (read and edit).
- **Watches:** across all nodes, with a live tail of the output.
- **Team view:** goal, members, branch, merge panel.
- **Settings:** Servers, defaults (model, effort, thresholds), Journalist budget.
- **Global:** command palette (⌘K), new agent (⌘N), terminal (⌘J), and macOS notifications for: agent finished and waiting, agent asked a question, watch done, rotation aborted, server disconnected.

**The spawn sheet asks only for:** name, role (optional preset), team (new or existing), model, task. That's all.

## 14. CLI (`axo`, on agents' PATH)

```
axo who                      list reachable agents (name, team, server, status)
axo ask <agent> "<msg>"      blocking question
axo tell <agent> "<msg>"     fire and forget
axo watch "<cmd>" [--label] [--until "<check>"] [--timeout 2h]
axo keeper read|save <tag>
axo rotate [--note]          request my own refresh at the next boundary
axo status
```

The CLI is a small file with no dependencies, and it is also deployed to every node.

---

## 15. Stack and repo layout

- **TypeScript everywhere.** Node 22+, ESM.
- **core:** `node:http` plus a tiny router (or Hono), `ws`, `node:sqlite`, `minimatch`, `ulid`. Bundled with esbuild into one file.
- **app:** Electron 41, electron-builder (dmg, notarized), electron-updater, `ssh` via `child_process`.
- **ui:** React 19, Vite 6, Tailwind 4, Zustand (one slice per area), Radix, lucide, CodeMirror 6, xterm 6, pdf.js.
- **Tests:** `node:test`. The **process lifecycle, rotation and delivery code is covered from Phase 1**, using a fake `claude` binary that replays recorded stream-json.

```
Axo-Project/
  SPEC.md
  package.json            (npm workspaces)
  packages/
    core/   src/{runtime,teams,journalist,rotator,innerchat,watches,keeper,files,terminal,store,api}/
    app/    src/{main,node-manager,ssh,keychain,preload}.ts
    ui/     src/{views,components,stores,lib}/
    cli/    src/axo.ts
  test/fixtures/stream-json/   recorded claude sessions
```

---

## 16. Phases

| # | Phase | Done when |
|---|---|---|
| 1 | **Core runtime**: repo scaffold, store, AgentRuntime (persistent processes, queue, resume, interrupt, idle reaping), stream parsing, REST/WS, minimal UI (sidebar + one chat pane), local node launched by the app | I can create an agent, chat across several turns in one process, kill the node, restart, and keep chatting with the same agent and conversation |
| 2 | **Teams**: projects/teams/worktrees, introducer, knock hook and scope locks, InnerChat and `axo` CLI, Watches with UI, split Fleet panes | Two agents in one team on a worktree; a scope violation is blocked; ask/tell works; a 10-minute watch wakes its agent after the app is closed and reopened |
| 3 | **Journalist and rotation**: state docs, map, decisions, team briefs, handoff ledger, triggers, hot-swap and verification, Refresh/Fork, Keeper | Mid-task Refresh: the successor continues the exact next step without asking me anything, and the chat shows only a divider |
| 4 | **Workspace**: editor, media (img/video/pdf), terminal, diff/merge view, State tab, cost and context strip | I can review and merge a team's branch in Axo |
| 5 | **Remote nodes**: server wizard, deploy, systemd, tunnels, reconnect and replay, multi-node sidebar, cross-node InnerChat | 3–4 servers in one window; closing the laptop lid doesn't interrupt server agents |
| 6 | **Polish**: notifications, signing and notarization, auto-update, Groove import, cron watches | Daily-driver ready |

## 17. What to port from Groove

| Groove | Axo |
|---|---|
| `providers/claude-code.js` `parseOutput` | rewrite against structured events (§4.2) |
| `deliver.js` queue / combining messages | `runtime/delivery.ts` |
| `innerchat.js`, `routes/innerchat.js`, `cli/commands/ask.js` | `innerchat/`, `cli/` (drop federation signing, add persistence) |
| `watcher.js`, `routes/watch.js` | `watches/`, almost as-is |
| `keeper.js`, `views/memory.jsx` | `keeper/`, `ui/views/memory` |
| `routes/files.js`, `filewatcher.js`, `mimetypes.js` | `files/` |
| `terminal-pty.js` | `terminal/`, replacing the Python PTY helper with `node-pty` built into the bundle *(or keep the Python helper: no native module, Python is on every server; decide in Phase 4)* |
| `templates/knock-hook.cjs` | `knock.sh` (curl-based, path normalization moved to the node) |
| `journalist.js` `callHeadless`, brief prompt | `journalist/` (incremental, per turn) |
| `rotator.js` guards (idle-loop, low-confidence brief) | `rotator/` (new triggers, hot-swap) |
| GUI theme (`app.css`), fleet panes, agent-feed live pill, file-tree, code-editor, media-viewer | `ui/` (TS port, simplified) |

## 18. Open questions and risks

1. ~~Interrupt support~~: verified working (Phase 1).
2. **Compaction event name** in `-p` stream-json, and whether auto-compact runs in print mode. *Verify in Phase 1 with a fixture.*
3. **Long-lived `-p` processes:** memory growth over days. This is handled by idle reaping and resume.
4. **Terminal PTY on Linux nodes** without a native build: see §17.
5. **Journalist cost:** per-turn Haiku updates. Estimate about 1–3K output tokens per meaningful turn; capped by the daily budget.
6. **Bash timeout vs `axo ask`:** confirm the default Bash tool timeout and document it.
