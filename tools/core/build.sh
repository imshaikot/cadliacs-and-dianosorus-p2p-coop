#!/usr/bin/env bash
# Reproducible: standalone FBNeo (CPS1+CPS2 subset) libretro core as a WASM module
# exposing the libretro C API to JS. Verified 2026-08-26 on Apple M4 / macOS.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

# 1. toolchain (EMSDK_OS is needed when platform.mac_ver() is unavailable, e.g. sandboxes)
git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$ROOT/emsdk"
EMSDK_PYTHON=$(command -v python3.13 || command -v python3) EMSDK_OS=macos \
  "$ROOT/emsdk/emsdk" install 3.1.74
EMSDK_PYTHON=$(command -v python3.13 || command -v python3) EMSDK_OS=macos \
  "$ROOT/emsdk/emsdk" activate 3.1.74
source "$ROOT/emsdk/emsdk_env.sh"

# 2. FBNeo (the libretro fork; upstream finalburnneo/FBNeo has no src/burner/libretro)
git clone --depth 1 https://github.com/libretro/FBNeo.git "$ROOT/FBNeo"
cd "$ROOT/FBNeo/src/burner/libretro"

# 3. regenerate driverlist.h for the cps12 subset (needs perl + a NATIVE cc/c++)
make generate-files platform=emscripten SUBSET=cps12

# 4. build the core as an ar archive of wasm objects (~5.6 s wall on M4, -j10)
#    EXTERNAL_ZLIB=0 overrides the platform block so FBNeo compiles its own zlib
#    instead of expecting -lz from the host frontend.
emmake make -j"$(sysctl -n hw.ncpu)" platform=emscripten SUBSET=cps12 EXTERNAL_ZLIB=0

# 5. WORKAROUND: Makefile.common wraps libretro-common in `ifneq ($(STATIC_LINKING),1)`
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
emar q fbneo_cps12_libretro_emscripten.bc $LC/*/*.o
cp fbneo_cps12_libretro_emscripten.bc "$ROOT/shim/fbneo_cps12.a"

# 6. link our own frontend shim -> 6.12 MB wasm (2.61 MB brotli), ~4 s
cd "$ROOT/shim"
emcc -O3 shim.c fbneo_cps12.a -o fbneo_cps12.mjs -I. \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createFBNeo \
  -sENVIRONMENT=web,worker -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 \
  -sSTACK_SIZE=4194304 -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,HEAPU32,HEAP16,UTF8ToString,stringToNewUTF8 \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_fe_install,_fe_load,_fe_set_input,_fe_fb,_fe_w,_fe_h,_fe_pitch,_fe_pixfmt,_fe_audio,_fe_audio_frames,_fe_fps,_fe_srate,_fe_ndesc,_fe_desc,_retro_init,_retro_run,_retro_reset,_retro_api_version,_retro_serialize_size,_retro_serialize,_retro_unserialize \
  --no-entry
