# Cadillacs & Dinosaurs — browser co-op

Three people, three browsers, one arcade cabinet. This runs the 1993 Capcom
CPS-1.5 beat-'em-up's built-in 3-player mode over WebRTC.

**Every player runs their own emulator; we synchronise inputs, not pixels.** A
frame is simulated only once every player's input for it has arrived, so all
three machines compute an identical game. The picture is local, so there is no
display latency — only input delay — and it costs about 1.8 KB/s per peer
instead of a video stream.

▶ **[Play it](https://imshaikot.github.io/cadliacs-and-dianosorus-p2p-coop/)**

## Requirements

- Node 20+ and Yarn 4 (the repo pins its own Yarn, so nothing to install)
- A Chromium- or Firefox-based browser
- Your own legally-dumped MAME `dino` ROM set — **one per player**, since every
  player runs their own emulator. This project will never send a ROM to anyone,
  and there is no code path that fetches one.

## Install

```sh
yarn install
cp .env.example .env      # optional; the defaults work
yarn dev                  # http://localhost:5173
```

Put your own dump at `roms/dino.zip`. That directory is gitignored. In
development Vite serves it directly; the deployed build has no such path and
asks each player to pick their file instead.

No Emscripten toolchain is needed — the emulator core is built ahead of time
and vendored.

## Playing

One person clicks **HOST A GAME** and gets a 12-character room code. The others
paste it and click **JOIN**. Either button opens the same dialog: type a name
and pick one of ten fighters, both of which the others see. Up to three players
— the host is player 1, guests get 2 and 3 in join order.

Nothing starts before that first click, on purpose: browsers refuse to open an
`AudioContext` without a real user gesture, and that click is the gesture.

**Controls**

| | |
|---|---|
| move | arrow keys or `WASD` |
| attack | `Z` |
| jump | `X` |
| insert coin | `5` |
| start | `1` |
| microphone | `M` |
| fullscreen | `F` |

Arcade conventions, so `5` then `1` begins a game. Every binding is remappable
from the controls panel, which also takes gamepads — plug one in, press a
button, and it appears with a deadzone slider and live axis meters.

**Voice chat.** You join muted, and muted means the microphone is genuinely
closed — no track, no recording indicator. Click the button on your portrait or
press <kbd>M</kbd> to open it. While somebody talks their name appears over the
picture, in fullscreen too. **hear** next to another player silences them for
you alone. Voice is peer to peer on its own connection and cannot slow the game
down. Headphones are worth it.

**Joining and leaving.** When somebody joins or leaves, the game pauses briefly
while everyone is handed the same savestate — that is what keeps the three
simulations identical. If a player vanishes, the rest drop them and carry on
within a few seconds.

## Built with

| | |
|---|---|
| emulator | [FBNeo](https://github.com/finalburnneo/FBNeo) CPS-1 driver, compiled to WebAssembly |
| transport | WebRTC data channels via [PeerJS](https://peerjs.com), behind a swappable `Transport` interface |
| sync | deterministic lockstep — inputs and savestates only, never video |
| audio clock | `AudioWorklet` metronome, because `requestAnimationFrame` stops in a backgrounded tab |
| build | [Vite](https://vite.dev) + TypeScript, yarn workspaces |

Runtime dependencies are `peerjs`, `vite` and `typescript`. That is the whole
list — the emulator core and the test harness each add nothing to it.

Deeper notes on how the pieces fit live in
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Licence

The core is FBNeo, which is **not** free software: non-commercial use only, no
donations, and source changes must be published. See
[`tools/core/README.md`](./tools/core/README.md).
