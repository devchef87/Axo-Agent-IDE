# Axo Mobile (Android) — v1 spec

A lightweight chat app, like the Claude app: a chat screen, and a drawer to pick which agent you're talking to.
That's all v1 is. You read agents' progress in the chat (watches wake them; their reports land there) and
send them messages and tasks.

**In v1:** drawer (server → team → agent, status dots), agent chat (live), send a message, Stop a working agent.
**Not in v1:** creating agents/teams, push notifications, files/editor, terminal, server setup, iOS.

## How the phone reaches agents

Phone → each Axo node **directly over Tailscale**. No Mac in the middle (the laptop can be closed), nothing hosted by us.

- Every server runs Tailscale. A node can additionally listen on its Tailscale address (`100.x.y.z:31500`).
  That listener is opt-in (`AXO_LISTEN_TAILSCALE=1` / node config) and only accepts **device tokens** (below)
  and the node token. `127.0.0.1` stays as it is for the desktop's SSH tunnels.
- Traffic is plain HTTP/WS inside Tailscale's WireGuard tunnel (encrypted end to end). Android blocks cleartext
  by default: allow it only for `100.64.0.0/10` via a network security config.
- Each node is independent: one node offline doesn't affect the others; the drawer shows it greyed out.

## Auth: device tokens

The phone never gets the node token. Each node issues a per-phone token, revocable from the desktop.

| Route | Who | |
|---|---|---|
| `POST /api/devices {name}` → `{id, name, token, createdAt}` | node token | issue a token for a phone |
| `GET /api/devices` → `Device[]` (no tokens) | node token | list |
| `DELETE /api/devices/:id` | node token | revoke (open WS for that device are closed) |

A device token may call **only**:

- `GET /api/version`, `GET /api/state` (projects, teams, agents)
- `GET /api/events?since=&epoch=` (catch-up) and `WS /ws?token=` (live `EventEnvelope`s: `agent:upsert`, `agent:feed`, …)
- `GET /api/agents/:id/feed?before=&limit=` (history paging)
- `POST /api/agents/:id/message {text}` (author is recorded as `user`)
- `POST /api/agents/:id/interrupt` (Stop)

Everything else (files, terminals, deletes, settings, innerchat admin) returns 401 for a device token.
Types live in `packages/protocol` (`Device`, `PairingPayload`).

## Pairing

Desktop: **Pair phone** (Settings / ⌘K). For every connected node with the Tailscale listener on, the app
creates a device token and shows one QR code containing:

```json
{ "v": 1, "nodes": [ { "id": "axom-spark", "name": "Axom Spark", "url": "http://100.101.102.103:31500", "token": "…" } ] }
```

The phone scans it and stores the node list in Android Keystore-backed secure storage (`expo-secure-store`).
Re-pairing replaces the list. "Paired phones" on the desktop lists devices per node with Revoke.

## The app

- **Stack:** Expo (React Native, TypeScript), Android only. Lives at `packages/mobile`, imports `@axo/protocol`
  types. Distribution: an APK built with EAS (`eas build -p android --profile preview`), sideloaded.
  During development, run it in Expo Go.
- **Look:** Axo's dark theme (slate `#24353D` / `#32424F`, accent `#28ACE6`). Like the desktop chat: your messages
  as right-aligned bubbles, agent replies left with markdown, tool calls collapsed to one line ("Ran 6 tools"),
  long replies folded, InnerChat and watch messages styled as such.
- **Drawer:** server → team → agent, each agent with a status dot (working / idle / error / refreshing) and the
  start of its last message. Remembers the last agent you opened.
- **Chat:** live via `/ws`; on reconnect, catch up with `/events?since=<last seq>` (if the node replies with a
  reset, reload state and feed). Older history pages in from `/agents/:id/feed`. Composer: multiline, send; while
  the agent is working, a Stop button; messages sent while it works are queued by the node (shown as queued).
- **Resilience:** phone sleep, network switches and node restarts all just reconnect; nothing to resend by hand.

## Build order

1. **Node (Axo-Manager):** Tailscale listener, device tokens + route allowlist, protocol types. Tests.
2. **Desktop (Axo-UI):** Pair phone QR + paired-devices list with revoke.
3. **App (Axo-Mobile):** can start immediately against the routes above using a token from
   `POST /api/devices` (curl with the node token) until pairing lands.

Done when: on the Android phone, off Wi-Fi, you open the drawer, pick an agent on the Spark, send it a task, and
watch its reply stream in, with the laptop closed.
