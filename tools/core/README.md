# The emulator core

`build.sh` produces a **standalone** FBNeo libretro core as a WASM module that
exposes the libretro C API to JavaScript, plus `shim.c`, a ~100-line libretro
frontend that lets us call it.

This is deliberately not EmulatorJS and not the RetroArch web build. Both of
those wrap the core in a frontend that owns the main loop, which makes
frame-stepped execution impossible — and frame-stepped execution is the whole
basis of this project's input synchronisation. See ARCHITECTURE.md.

## Rebuilding

```sh
tools/core/build.sh
cp <output> packages/client/src/emulator/core/
```

Needs: git, perl, a native C++ compiler, and ~10 minutes for the first run
(most of it downloading emsdk). Rebuilds after that take about 10 seconds.

Pinned to FBNeo commit `f3b7749` and emsdk `3.1.74`. The build output is
vendored in `packages/client/src/emulator/core/` so none of this is needed to
just run the app.

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
