# Axo

Agent OS for teams of Claude Code agents across a local machine and remote servers. The design source of truth is `SPEC.md`; read the section for your area before changing it.

## Layout

```
packages/protocol   wire types shared by everything (types only; always `import type`)
packages/core       axo-node: agent runtime, store (node:sqlite), REST + WS API. Runs locally and on servers.
packages/ui         React 19 + Vite + Tailwind 4 + Zustand renderer
packages/app        Electron shell: starts/attaches the detached local node, window, IPC
packages/cli        `axo` CLI for agents (phase 2)
```

## Commands

```
npm test              core tests (node:test, uses a fake claude binary; no tokens spent)
npm run typecheck     tsc for core, ui, app
npm run build         ui → core bundle (dist/axo-node.mjs) → app
npm run app           build + launch Electron
npm run dev:ui        Vite on :5199 (pair with `npm run dev -w @axo/app`)
npm run node          run the node from source on :31500
```

## Conventions

- **TypeScript runs natively** (Node 22 type stripping). Use `.ts` extensions in relative imports and **erasable syntax only**: no enums, no namespaces, no constructor parameter properties.
- **Protocol first.** Any new REST route or WS event goes into `packages/protocol/src/index.ts` before it is implemented.
- **One entry point for messages:** `AgentRuntime.deliver()`. Never write to a claude process from anywhere else.
- **Agent IDs are permanent.** Never key state by session ID or process.
- **Bounded data.** Anything that grows (feed, usage, logs) needs a retention rule.
- **No native modules** in core (it is deployed as one file to servers). Use `node:sqlite`, `node:crypto`, etc.
- **Tests:** runtime behaviour is tested against `packages/core/test/fixtures/fake-claude.mjs`. Extend the fake (keywords in the message drive its behaviour) rather than calling the real CLI in tests.
- Ports: local node **31500** (Groove uses 31415; both can run side by side). Home: `~/.axo/`.
- The UI must never assume a single node: everything is keyed by `nodeKey`.

## Verified Claude Code behaviour (CLI 2.1.280)

- `claude -p --input-format stream-json --output-format stream-json --verbose` stays alive across turns; one JSONL `{"type":"user",…}` per turn; `result` marks the turn boundary; `system/init` is re-emitted each turn.
- `--session-id <uuid>` is honoured; `--resume <uuid>` continues the same session ID.
- Interrupt: write `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}`. You get a `control_response`, then a `result` with subtype `error_during_execution`; the process stays alive.
- `--include-partial-messages` emits `stream_event` text deltas.
