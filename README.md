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
| **M1** | Emulator boots locally | **done, verified** — `npm run verify:m1` |
| M2 | A/V streaming to guest | not started |
| M3 | Guest input drives player 2 | not started |
| M4 | Third player, room UX, latency HUD | not started |
| M5 | Docs and deploy notes | not started |

## Requirements

- Node 20+ (developed on 26)
- A Chromium or Firefox-based browser
- Your own legally-dumped MAME `dino` ROM set

No Emscripten toolchain is needed. The emulator core is built ahead of time and
vendored; see [`tools/core/README.md`](./tools/core/README.md) to rebuild it.

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

The host's browser is the arcade cabinet: it runs the emulator, and everyone
else will watch its output over WebRTC from M2 onward.

### Controls (host, player 1)

| | |
|---|---|
| move | arrow keys or `WASD` |
| attack | `Z` |
| jump | `X` |
| insert coin | `5` |
| start | `1` |

Arcade conventions, so `5` then `1` begins a game. Guests get ports 2 and 3
in M3.

### The ROM, in development vs production

In development, Vite already serves the repo root, so the app reads your
`roms/dino.zip` directly with no copying and no plugin. A production build has
no such path and no ROM in the bundle, so it asks you to pick the file.

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
npm run verify:m1
```

Both harnesses launch headless Chrome and drive real tabs with real mouse and
keyboard events — never synthetic `.click()`, so anything gated on user
activation behaves as it does for a person. Screenshots land in
`tools/verify/shots/`.

- `verify:m0` asserts the handshake plus the transport facts recorded in
  ARCHITECTURE.md. It needs the dev server, because it uses an
  `import.meta.env.DEV`-only hook to force a room-code collision on purpose.
- `verify:m1` asserts the emulator boots, holds 59.63Hz, renders, and is
  keyboard-controllable. Controllability is proven twice over: real key events
  must set the right bits in the input latch, and from an identical savestate a
  run with input must diverge from one without.

## Layout

```
packages/shared            Transport interface, wire protocol, room codes, PeerJS adapter
packages/client            Vite app: UI, session, config
  src/emulator/            core wrapper, frame loop, renderer, audio, input latch
  src/emulator/core/       vendored WASM build output (generated)
scripts/                   check-layering.mjs — enforces the one architectural rule
tools/core/                build.sh + shim.c — how the WASM core is produced
tools/verify/              zero-dependency CDP harness for milestone acceptance
```

## Dependencies

`peerjs`, `vite`, `typescript`. That is the whole list.

The emulator core adds nothing to it — it is a WASM module we build and vendor,
driven by our own code. The verification harness adds nothing either; it drives
Chrome over the DevTools protocol using Node's built-in `WebSocket` and `fetch`.

The core is FBNeo, which is **not** free software: non-commercial use only, no
donations, source changes must be published. See
[`tools/core/README.md`](./tools/core/README.md).
