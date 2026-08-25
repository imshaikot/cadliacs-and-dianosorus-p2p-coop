# Cadillacs & Dinosaurs — browser co-op

Three people, three browsers, one arcade cabinet. This runs the 1993 Capcom
CPS-1.5 beat-'em-up's built-in 3-player mode over WebRTC. The game itself is not
modified; all of the work is input synchronisation and A/V transport around the
emulator.

**V1 is host-authoritative streaming.** One peer runs the emulator, captures its
canvas and audio, and sends them to the other two as WebRTC media tracks. Guests
run no emulator at all: they render a `<video>`, capture local input, and ship it
back over a data channel. See [ARCHITECTURE.md](./ARCHITECTURE.md).

## Status

| Milestone | | |
|---|---|---|
| **M0** | PeerJS handshake | **done, verified** — `npm run verify:m0` |
| M1 | Emulator boots locally | not started |
| M2 | A/V streaming to guest | not started |
| M3 | Guest input drives player 2 | not started |
| M4 | Third player, room UX, latency HUD | not started |
| M5 | Docs and deploy notes | not started |

## Requirements

- Node 20+ (developed on 26)
- A Chromium or Firefox-based browser
- Your own legally-dumped MAME `dino` ROM set

## Setup

```sh
npm install
cp .env.example .env      # optional; the defaults work
npm run dev               # http://localhost:5173
```

### The ROM

Put your own dump at `roms/dino.zip`. That directory is gitignored and nothing
in it is ever committed. This project will not download a ROM for you, and there
is no code path that fetches one.

The ROM is not used until M1.

## Playing

1. One person opens the app and clicks **HOST A GAME**. They get a 12-character
   room code and a shareable link (the **copy** button copies the link).
2. The others open the app, paste the code, and click **JOIN**.
3. Nothing starts before that click, on purpose — browsers refuse to start an
   `AudioContext` or autoplay audio without a real user gesture, and that click
   is the gesture.

Up to three players. The host is always player 1 because it owns the emulator;
guests get 2 and 3 in join order.

## Configuration

Everything lives in `.env` at the repo root. See [`.env.example`](./.env.example)
for the full list. Nothing is required.

### Self-hosting the signalling broker

By default the app signals through the public PeerJS cloud broker. It is rate
limited and periodically unreliable, so when it starts misbehaving:

```sh
npx peerjs --port 9000 --path /dino
```

then in `.env`:

```
VITE_PEER_HOST=localhost
VITE_PEER_PORT=9000
VITE_PEER_PATH=/dino
VITE_PEER_SECURE=false
```

No code changes. The header line at the top of the page tells you which broker
you are actually on.

### TURN

PeerJS ships Google's STUN servers, which covers most home networks. Symmetric
NAT needs TURN, which needs credentials — set the whole ICE list as JSON in
`VITE_ICE_SERVERS`. No TURN provider is signed up for or hard-coded.

## Verifying

```sh
npm run check        # typecheck + the layering rule
npm run dev          # in one terminal
npm run verify:m0    # in another
```

`verify:m0` launches headless Chrome, drives two real tabs with real mouse and
keyboard events, and asserts the M0 acceptance criteria plus the transport
facts documented in ARCHITECTURE.md. It writes screenshots to
`tools/verify/shots/`. It needs the dev server, because it exercises a
`import.meta.env.DEV`-only hook to force a room-code collision on purpose.

## Layout

```
packages/shared    Transport interface, wire protocol, room codes, PeerJS adapter
packages/client    Vite app: UI, session, config
scripts/           check-layering.mjs — enforces the one architectural rule
tools/verify/      zero-dependency CDP harness for milestone acceptance
```

## Dependencies

`peerjs`, `vite`, `typescript`. That is the whole list, and the verification
harness deliberately adds nothing to it — it drives Chrome over the DevTools
protocol using Node's built-in `WebSocket` and `fetch`.
