#!/usr/bin/env bash
# Reproducible: a standalone FBNeo libretro core as a WASM module exposing the
# libretro C API to JS. Verified 2026-08-26 on Apple M4 / macOS.
#
#   tools/core/build.sh            # cps12  — CPS-1 + CPS-2
#   tools/core/build.sh neogeo     # neogeo — Neo Geo MVS/AES
#
# The subset name is FBNeo's own: it must have a `Makefile.<subset>` in
# src/burner/libretro. Everything else about the two builds is identical, which
# is the point — one core per hardware family, and the frontend picks.
set -euo pipefail
SUBSET="${1:-cps12}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
# Everything downloaded or generated lives here, gitignored. Keeping it means a
# second subset costs ten seconds instead of ten minutes.
WORK="$ROOT/.work"
OUT="$ROOT/out/$SUBSET"
mkdir -p "$WORK" "$OUT"

# 1. toolchain.
#    emsdk needs Python >= 3.10 and macOS still ships 3.9 as `python3`, so the
#    interpreter is chosen by version rather than by name. EMSDK_OS is needed
#    when platform.mac_ver() is unavailable, e.g. in sandboxes.
PY=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
  path=$(command -v "$candidate" || true)
  [ -n "$path" ] || continue
  if "$path" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
    PY="$path"; break
  fi
done
[ -n "$PY" ] || { echo "need Python 3.10+; try: brew install python@3.12" >&2; exit 1; }

if [ ! -d "$WORK/emsdk" ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$WORK/emsdk"
fi
EMSDK_PYTHON="$PY" EMSDK_OS=macos "$WORK/emsdk/emsdk" install 3.1.74
EMSDK_PYTHON="$PY" EMSDK_OS=macos "$WORK/emsdk/emsdk" activate 3.1.74
source "$WORK/emsdk/emsdk_env.sh"

# 2. FBNeo (the libretro fork; upstream finalburnneo/FBNeo has no src/burner/libretro)
if [ ! -d "$WORK/FBNeo" ]; then
  git clone --depth 1 https://github.com/libretro/FBNeo.git "$WORK/FBNeo"
fi
cd "$WORK/FBNeo/src/burner/libretro"

# 3. Objects land next to their sources, so two subsets sharing one checkout
#    would link each other's leftovers. Wipe only when the subset actually
#    changed, so rebuilding the same one stays a ten-second job.
STAMP="$WORK/.last-subset"
if [ "$(cat "$STAMP" 2>/dev/null || true)" != "$SUBSET" ]; then
  make clean platform=emscripten SUBSET="$SUBSET" >/dev/null 2>&1 || true
fi
echo "$SUBSET" > "$STAMP"

# 4. regenerate driverlist.h for this subset (needs perl + a NATIVE cc/c++)
make generate-files platform=emscripten SUBSET="$SUBSET"

# 5. build the core as an ar archive of wasm objects (~5.6 s wall on M4, -j10)
#    EXTERNAL_ZLIB=0 overrides the platform block so FBNeo compiles its own zlib
#    instead of expecting -lz from the host frontend.
emmake make -j"$(sysctl -n hw.ncpu)" platform=emscripten SUBSET="$SUBSET" EXTERNAL_ZLIB=0

# 6. WORKAROUND: Makefile.common wraps libretro-common in `ifneq ($(STATIC_LINKING),1)`
#    because it assumes RetroArch supplies those symbols. A standalone link needs them.
LC=libretro-common
for f in $LC/file/file_path.c $LC/file/file_path_io.c $LC/file/retro_dirent.c \
         $LC/encodings/encoding_utf.c $LC/compat/compat_posix_string.c \
         $LC/compat/compat_strcasestr.c $LC/compat/compat_strl.c \
         $LC/compat/compat_strldup.c $LC/compat/fopen_utf8.c $LC/string/stdstring.c \
         $LC/streams/file_stream.c $LC/streams/file_stream_transforms.c \
         $LC/features/features_cpu.c $LC/file/config_file.c \
         $LC/file/config_file_userdata.c $LC/lists/string_list.c \
         $LC/memmap/memalign.c $LC/time/rtime.c $LC/vfs/vfs_implementation.c; do
  emcc -c -O3 -DNDEBUG -D__LIBRETRO__ -DLSB_FIRST -DHAVE_UNISTD_H \
       -D_FILE_OFFSET_BITS=64 -DUSE_LIBRETRO_VFS -I$LC/include -I. -o "${f%.c}.o" "$f"
done
emar q "fbneo_${SUBSET}_libretro_emscripten.bc" $LC/*/*.o
cp "fbneo_${SUBSET}_libretro_emscripten.bc" "$OUT/fbneo_${SUBSET}.a"
cp libretro-common/include/libretro.h "$OUT/libretro.h"

# 7. link our own frontend shim -> ~6 MB wasm, ~4 s
cd "$OUT"
cp "$ROOT/shim.c" .
emcc -O3 shim.c "fbneo_${SUBSET}.a" -o "fbneo_${SUBSET}.mjs" -I. \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createFBNeo \
  -sENVIRONMENT=web,worker -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 \
  -sSTACK_SIZE=4194304 -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,HEAPU32,HEAP16,UTF8ToString,stringToNewUTF8 \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_fe_install,_fe_load,_fe_set_input,_fe_fb,_fe_w,_fe_h,_fe_pitch,_fe_pixfmt,_fe_audio,_fe_audio_frames,_fe_fps,_fe_srate,_fe_ndesc,_fe_desc,_retro_init,_retro_run,_retro_reset,_retro_api_version,_retro_serialize_size,_retro_serialize,_retro_unserialize \
  --no-entry

# 8. the romset names this core knows, so the frontend can tell a player which
#    emulator their file belongs to instead of relaying FBNeo's silent refusal.
node "$ROOT/drivers.mjs" \
  "$WORK/FBNeo/src/dep/generated/driverlist.h" \
  "$WORK/FBNeo/src/burn/drv" > "$OUT/fbneo_${SUBSET}.drivers.json"

echo
echo "built $OUT/fbneo_${SUBSET}.{mjs,wasm,drivers.json}"
echo "copy all three into packages/client/src/emulator/core/"
