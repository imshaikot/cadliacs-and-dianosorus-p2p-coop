# Generated — do not edit

Two cores, one shim. Each `fbneo_<subset>.{mjs,wasm}` pair is a standalone FBNeo
libretro core for one hardware family plus our own frontend shim, exposing the
libretro C API directly to JavaScript:

| subset | hardware | what a player calls it |
|---|---|---|
| `cps12` | Capcom CP System I + II | Street Fighter II, Final Fight, Cadillacs and Dinosaurs |
| `neogeo` | SNK Neo Geo MVS/AES | Metal Slug, The King of Fighters, Samurai Shodown |

Only one is ever loaded — `emulator/fbneo.ts` imports them dynamically so the
bundler splits them, and a room downloads the core it chose and no other.

`fbneo_<subset>.drivers.json` beside each is the list of romset names that core
was built with, produced by `tools/core/drivers.mjs`. It exists because FBNeo's
`retro_load_game` returns **true** for a zip whose basename matches no driver at
all, and then emulates nothing at a fictional 60Hz — so the frontend checks the
name itself, before any bytes reach the core. See `emulator/rom.ts`.

`fbneo_neogeo.d.mts` re-exports the cps12 types rather than repeating them: same
shim, same exports, so one description is the honest number.

Rebuild with `tools/core/build.sh [subset]`. Source of truth is
`tools/core/shim.c` and FBNeo pinned at commit `f3b7749`.

FBNeo is not MIT/GPL — see `tools/core/README.md` for the license terms that
come with these bytes.
