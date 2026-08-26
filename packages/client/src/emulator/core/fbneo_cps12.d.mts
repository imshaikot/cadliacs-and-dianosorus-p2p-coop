/**
 * Hand-written types for the Emscripten module built by `tools/core/build.sh`.
 * The `fe_*` functions come from our own `tools/core/shim.c`; the `retro_*`
 * ones are the libretro C API exposed straight out of FBNeo.
 */
export interface FbneoWasm {
  /** Re-read these every frame: ALLOW_MEMORY_GROWTH invalidates old views. */
  readonly HEAPU8: Uint8Array;
  readonly HEAP16: Int16Array;
  readonly HEAPU32: Uint32Array;
  readonly FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    analyzePath(path: string): { exists: boolean };
  };
  UTF8ToString(ptr: number): string;
  stringToNewUTF8(value: string): number;
  _malloc(bytes: number): number;
  _free(ptr: number): void;

  /** Wire our callbacks into the core. Call once, before retro_init. */
  _fe_install(): void;
  /** retro_load_game with a path into the Emscripten FS. 1 on success. */
  _fe_load(pathPtr: number): number;
  /** Latch a joypad bitmask for one port. Read once per retro_run. */
  _fe_set_input(port: number, mask: number): void;
  _fe_fb(): number;
  _fe_w(): number;
  _fe_h(): number;
  _fe_pitch(): number;
  _fe_pixfmt(): number;
  _fe_audio(): number;
  _fe_audio_frames(): number;
  _fe_fps(): number;
  _fe_srate(): number;
  _fe_ndesc(): number;
  _fe_desc(index: number, portOut: number, idOut: number): number;

  _retro_init(): void;
  _retro_run(): void;
  _retro_reset(): void;
  _retro_api_version(): number;
  _retro_serialize_size(): number;
  _retro_serialize(ptr: number, size: number): number;
  _retro_unserialize(ptr: number, size: number): number;
}

export interface FbneoModuleOptions {
  locateFile?: (path: string) => string;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}

export default function createFBNeo(options?: FbneoModuleOptions): Promise<FbneoWasm>;
