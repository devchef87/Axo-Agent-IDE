# Axo Mobile (Android)

A small chat client for Axo agents: a drawer to pick server → team → agent, a live chat, send, and Stop.
It talks to each Axo node directly over Tailscale. Spec: `docs/MOBILE.md`.

This package is **not** an npm workspace member (React Native would weigh down every root install).
It has its own `node_modules` and uses `@axo/protocol` as types only (`import type`, via tsconfig `paths`).

```
cd packages/mobile
npm install
npm test            # pure logic (pairing, feed grouping), node:test
npm run typecheck
npx expo start      # dev: open in Expo Go on the phone (same Wi-Fi, or --tunnel)
sh scripts/build-apk.sh   # local release APK → ~/Desktop/axo-mobile.apk (Android SDK + JDK 17; ~7 min)
npm run apk         # or build it in the cloud with EAS (needs an Expo account)
```

## Layout

```
App.tsx                      shell: pairing gate, header, chat, drawer
src/lib/client.ts            one connection per node: REST + WS, /events catch-up, reconnect on wake
src/lib/store.ts             zustand: nodes, feeds (only the open one in memory), previews, selection
src/lib/pairing.ts           QR payload parsing; http only to 100.64.0.0/10 and *.ts.net
src/lib/storage.ts           expo-secure-store (Android Keystore): paired nodes + last agent
src/lib/feed.ts              grouping, folding, previews (pure, tested)
src/components/              feed, markdown (marked lexer → RN Text), drawer, composer, pair screen
```

## Testing without the desktop pairing flow

Issue a device token on a node (node token from `~/.axo/node.token`), then paste a payload on the pair screen:

```
curl -s -X POST http://127.0.0.1:31500/api/devices -H "Authorization: Bearer $(cat ~/.axo/node.token)" \
  -H 'Content-Type: application/json' -d '{"name":"Pixel"}'
# → paste: {"v":1,"nodes":[{"id":"spark","name":"Spark","url":"http://100.x.y.z:31500","token":"<token>"}]}
```

Cleartext HTTP is enabled app-wide (Android's network security config can't express a CIDR range);
the app itself refuses http URLs outside Tailscale. Dev builds also accept `localhost` and `10.0.2.2`
(the Android emulator's alias for the host) so you can point the emulator at a local node.
