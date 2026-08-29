# The emulator core

`build.sh` produces a **standalone** FBNeo libretro core as a WASM module that
exposes the libretro C API to JavaScript, plus `shim.c`, a ~100-line libretro
frontend that lets us call it.

This is deliberately not EmulatorJS and not the RetroArch web build. Both of
those wrap the core in a frontend that owns the main loop, which makes
frame-stepped execution impossible — and frame-stepped execution is the whole
basis of this project's input synchronisation.

## Rebuilding

```sh
tools/core/build.sh            # cps12  — CPS-1 + CPS-2 (the default)
tools/core/build.sh neogeo     # neogeo — Neo Geo MVS/AES
cp tools/core/out/<subset>/fbneo_<subset>.{mjs,wasm,drivers.json} \
   packages/client/src/emulator/core/
```

The argument is FBNeo's own subset name: it needs a `Makefile.<subset>` in
`src/burner/libretro`. Nothing else about the two builds differs, which is the
point — one core per hardware family, and the frontend picks between them.

Needs: git, perl, **Python 3.10+**, a native C++ compiler, and ~10 minutes for
the first run (most of it downloading emsdk). Rebuilds after that take about 10
seconds. macOS still ships Python 3.9 as `python3` and emsdk refuses it, so the
script picks an interpreter by version rather than by name.

Everything downloaded or generated lives in `tools/core/.work/` and
`tools/core/out/`, both gitignored, so building a second subset costs seconds
rather than another emsdk download. Objects land next to their sources in the
FBNeo tree, so the script wipes them when the subset changes and only then.

Pinned to FBNeo commit `f3b7749` and emsdk `3.1.74`. The build output is
vendored in `packages/client/src/emulator/core/` so none of this is needed to
just run the app.

## The driver manifest

`drivers.mjs` writes `fbneo_<subset>.drivers.json` — every romset name the core
was built with. This is not a convenience:

> **FBNeo's refusal is not a refusal.** `retro_load_game` returns *true* for a
> zip whose basename matches no driver, then reports the libretro defaults
> (exactly 60.00Hz, exactly 48000Hz — no CPS or Neo Geo board runs at either)
> and the frontend starts a machine that emulates nothing. Measured with a
> 64-byte file named `Metal Slug (1996).zip`: 89 frames "ran", black canvas, not
> one error anywhere.

It does the same for a name it *does* have whose ROMs are missing — which for
Neo Geo means the BIOS is absent, easily the most common mistake.

So the frontend checks the name against the manifest before handing over any
bytes, using FBNeo's own rule — the basename, and nothing else — and then checks
the AV info afterwards, because the libretro defaults are a pair no CPS or Neo
Geo driver produces. Two sources are intersected to build the manifest:
`driverlist.h`, generated per subset, says which drivers were linked but holds C
symbols; the driver sources hold the romset names but all of them. The
intersection is this core's names and only those.

## Two things that will bite you if you change the build

1. **`STATIC_LINKING=1` drops libretro-common.** FBNeo's `Makefile.common`
   excludes it on the assumption that RetroArch supplies those symbols. A
   standalone link does not have RetroArch, so `build.sh` compiles 19 extra
   `.c` files by hand and `emar q`s them into the archive. That list mirrors a
   block in FBNeo's Makefile and will rot silently when upstream adds a file —
   which is the main reason the commit is pinned.

2. **Rejecting every environment callback is not safe.** If the frontend
   refuses all three offered pixel formats, `nBurnBpp` stays 0 and the core
   traps deep inside `CpstOne()` with an opaque "function signature mismatch"
   and no diagnostic. `shim.c` must keep answering at minimum
   `SET_PIXEL_FORMAT`, `GET_VARIABLE`, `GET_LOG_INTERFACE`,
   `GET_INPUT_BITMASKS`, `SET_INPUT_DESCRIPTORS`, `GET_SYSTEM_DIRECTORY` and
   `GET_SAVE_DIRECTORY`.

## License

FBNeo is **not** free software in the usual sense. Verbatim from its
`LICENSE.md`:

> You may freely use, modify, and distribute both the FB Neo source code and
> binary, however the following restrictions apply […]
> - You may not sell, lease, rent or otherwise seek to gain monetary profit from FB Neo;
> - You must make public any changes you make to the source code;
> - You must include, verbatim, the full text of this license;
> - You may not distribute FB Neo with ROM images unless you have the legal right to distribute them;
> - You may not ask for donations to support your work on any project that uses the FB Neo source code.

FBNeo also carries the MAME license by descent. This project is non-commercial
and ships no ROMs, so it complies — but that constrains what this can ever
become.
