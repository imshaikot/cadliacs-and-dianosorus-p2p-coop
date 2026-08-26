# Generated — do not edit

`fbneo_cps12.mjs` and `fbneo_cps12.wasm` are build output, vendored so a clone
runs without an Emscripten toolchain. They are a standalone FBNeo `SUBSET=cps12`
(CPS-1 + CPS-2) libretro core plus our own frontend shim, exposing the libretro
C API directly to JavaScript.

Rebuild with `tools/core/build.sh`. Source of truth is `tools/core/shim.c` and
FBNeo pinned at commit `f3b7749`.

FBNeo is not MIT/GPL — see `tools/core/README.md` for the license terms that
come with these bytes.
