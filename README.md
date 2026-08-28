# Retro P2P — arcade co-op in your browser

Two or three people, two or three browsers, one arcade cabinet. Load a CPS-1 or
CPS-2 romset and play its built-in multiplayer mode together over WebRTC.

**Every player runs their own emulator; we synchronise inputs, not pixels.** A
frame is simulated only once every player's input for it has arrived, so all
machines compute an identical game. The picture is local, so there is no display
latency — only input delay — and it costs about 1.8 KB/s per peer instead of a
video stream.

▶ **[Play it](https://imshaikot.github.io/retro-games-p2p-multiplayer-coop/)**

## Requirements

- Node 20+ and Yarn 4 (the repo pins its own Yarn, so nothing to install)
- A Chromium- or Firefox-based browser
- A CPS-1 or CPS-2 romset zip you are entitled to use. **This player ships no
  games and downloads none** — there is no code path that could.

## Install

```sh
yarn install
cp .env.example .env      # optional; the defaults work
yarn dev                  # http://localhost:5173
```

To skip the file picker while developing, drop a zip in `roms/` and name it:

```
VITE_ROM_FILE=yourgame.zip
```

The driver is read from the filename, so `sf2.zip` boots `sf2`. There is no
default, and a production build has no such path at all.

No Emscripten toolchain is needed — the emulator core is built ahead of time and
vendored.

## Playing

One person clicks **Host a game**, picks whether the room is for two or three,
and gets a 12-character code. The others paste it and click **Join** — or open
the link the host copies, which fills the code in for them. Either button opens
the same dialog: type a name and pick a token, both of which the others see. The
host is player 1; guests get 2 and 3 in join order.

Nothing starts before that first click, on purpose: browsers refuse to open an
`AudioContext` without a real user gesture, and that click is the gesture.

**You only need one copy between you.** Whoever loads a game first offers it to
the room, and anyone without one receives it over the same peer-to-peer mesh the
game runs on. You can always load your own file instead. The line under the
picture says which game is loaded and whose copy it is.

**Controls**

| | |
|---|---|
| move | arrow keys or `WASD` |
| buttons 1–3 | `U` `I` `O` |
| buttons 4–6 | `J` `K` `L`, or `Z` `X` `C` |
| insert coin | `5` |
| start | `1` |
| microphone | `M` |
| fullscreen | `F` |

Arcade conventions, so `5` then `1` begins a game. Six buttons because a fighter
needs six; a beat-'em-up just uses the first two. Every binding is remappable
from the control panel, which also takes gamepads — plug one in, press a button,
and it appears with a deadzone slider and live axis meters.

**Voice chat.** You join muted, and muted means the microphone is genuinely
closed — no track, no recording indicator. Click the button on your token or
press <kbd>M</kbd> to open it. While somebody talks their name appears over the
picture, in fullscreen too. **hear** next to another player silences them for you
alone. Voice is peer to peer on its own connection and cannot slow the game down.
Headphones are worth it.

**Joining and leaving.** When somebody joins or leaves, the game pauses briefly
while everyone is handed the same savestate — that is what keeps the simulations
identical. If a player vanishes, the rest drop them and carry on within a few
seconds.

## Built with

| | |
|---|---|
| emulator | [FBNeo](https://github.com/finalburnneo/FBNeo) CPS-1/CPS-2 drivers, compiled to WebAssembly |
| transport | WebRTC data channels via [PeerJS](https://peerjs.com), behind a swappable `Transport` interface |
| sync | deterministic lockstep — inputs and savestates only, never video |
| audio clock | `AudioWorklet` metronome, because `requestAnimationFrame` stops in a backgrounded tab |
| build | [Vite](https://vite.dev) + TypeScript, yarn workspaces |

Runtime dependencies are `peerjs`, `vite` and `typescript`. That is the whole
list — the emulator core, the router and the test harness each add nothing.

Deeper notes on how the pieces fit live in
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Licence

The core is FBNeo, which is **not** free software: non-commercial use only, no
donations, and source changes must be published. See
[`tools/core/README.md`](./tools/core/README.md).
