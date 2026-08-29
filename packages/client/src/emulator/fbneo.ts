import type { SystemId } from '@retro/shared';

import type { FbneoModuleOptions, FbneoWasm } from './core/fbneo_cps12.mjs';
import cps12WasmUrl from './core/fbneo_cps12.wasm?url';
import neogeoWasmUrl from './core/fbneo_neogeo.wasm?url';
import type { RomFile } from './rom.js';

/**
 * Thin typed skin over the WASM core. Deliberately owns no timing and no
 * policy: it exposes one-frame-at-a-time execution and nothing else, because
 * the whole netcode design depends on us deciding when a frame happens.
 */

/**
 * One core per hardware family, and only the selected one is ever fetched.
 *
 * The glue is behind a dynamic import so the bundler splits it: choosing CPS
 * never downloads six megabytes of Neo Geo. The `?url` imports beside it are
 * only strings — Emscripten fetches the `.wasm` when the factory runs, not when
 * the module is imported — so naming both here costs nothing.
 */
type FbneoFactory = (options?: FbneoModuleOptions) => Promise<FbneoWasm>;

const CORES: Readonly<Record<SystemId, () => Promise<{ create: FbneoFactory; wasmUrl: string }>>> = {
  cps12: async () => ({
    create: (await import('./core/fbneo_cps12.mjs')).default,
    wasmUrl: cps12WasmUrl,
  }),
  neogeo: async () => ({
    create: (await import('./core/fbneo_neogeo.mjs')).default,
    wasmUrl: neogeoWasmUrl,
  }),
};

/**
 * Did `retro_load_game` actually start anything?
 *
 * It says true either way. Handed a zip it has no driver for — or one it does,
 * whose ROMs are missing, which for Neo Geo means *the BIOS is not there* — it
 * logs "None of those archives was found in your paths", returns success, and
 * leaves the machine at the libretro defaults. The frontend then runs a clock
 * against nothing: measured, 149 frames "advanced" onto a black canvas with no
 * error raised anywhere.
 *
 * Exactly 60.000000Hz into exactly 48000Hz is that default, and it is not a
 * game: CPS-1 is 59.6294Hz into 48002.15Hz and Neo Geo is 59.185606Hz, because
 * FBNeo nudges the sample rate to a whole number of samples per frame. Neither
 * subset contains a driver that could produce this pair, so it means one thing.
 *
 * A third subset could, in principle, hold a genuine 60.000Hz machine. It would
 * be refused with the "set is incomplete" message, which is wrong but visible —
 * far better than the silence this replaces.
 */
function isEmptyMachine(fps: number, sampleRate: number): boolean {
  return fps === 60 && sampleRate === 48000;
}

/** RETRO_PIXEL_FORMAT_*. FBNeo gives us XRGB8888 once we accept it. */
export const PIXEL_XRGB8888 = 1;
export const PIXEL_RGB565 = 2;

export interface VideoFrame {
  /** A view into WASM memory. Valid only until the next runFrame(). */
  pixels: Uint8Array;
  width: number;
  height: number;
  /** Bytes per row, which is not necessarily width * 4. */
  pitch: number;
  format: number;
}

export interface InputDescriptor {
  port: number;
  id: number;
  name: string;
}

export class FbneoCore {
  readonly system: SystemId;
  #m: FbneoWasm;
  #fps = 0;
  #sampleRate = 0;
  #loaded = false;
  #stateBuf = 0;
  #stateSize = 0;

  private constructor(system: SystemId, module: FbneoWasm) {
    this.system = system;
    this.#m = module;
  }

  static async load(system: SystemId, onLog?: (line: string) => void): Promise<FbneoCore> {
    const { create, wasmUrl } = await (CORES[system] ?? CORES.cps12)();
    const module = await create({
      // Vite rewrites the .wasm to a hashed asset URL; without this the
      // Emscripten glue would look for it next to the .mjs and 404 in prod.
      locateFile: () => wasmUrl,
      print: (t) => onLog?.(t),
      printErr: (t) => onLog?.(t),
    });
    module._fe_install();
    module._retro_init();
    return new FbneoCore(system, module);
  }

  /**
   * FBNeo sets `need_fullpath` and `block_extract`, so it will not accept a
   * buffer — it wants a path and opens the zip itself. We hand it one inside
   * the Emscripten in-memory filesystem. Nothing touches the network, and the
   * driver is chosen purely from the basename: sf2.zip -> driver `sf2`.
   *
   * `alongside` is written into the same directory and never named to the core.
   * FBNeo goes looking for the driver's board ROM by itself — every Neo Geo
   * driver boots through `neogeo.zip` — and finds it there or refuses the game.
   */
  loadRom(fileName: string, bytes: Uint8Array, alongside: readonly RomFile[] = []): void {
    if (this.#loaded) throw new Error('a ROM is already loaded');
    const m = this.#m;
    for (const dir of ['/roms', '/fbneo', '/fbneo/system', '/fbneo/save']) {
      if (!m.FS.analyzePath(dir).exists) m.FS.mkdir(dir);
    }
    for (const file of alongside) m.FS.writeFile(`/roms/${file.name}`, file.bytes);
    const path = `/roms/${fileName}`;
    m.FS.writeFile(path, bytes);
    const ptr = m.stringToNewUTF8(path);
    try {
      if (!m._fe_load(ptr)) throw new Error(`FBNeo refused to load ${fileName}`);
    } finally {
      m._free(ptr);
    }
    const fps = m._fe_fps();
    const sampleRate = m._fe_srate();
    if (isEmptyMachine(fps, sampleRate)) {
      throw new Error(`FBNeo started no driver for ${fileName}`);
    }
    this.#loaded = true;
    this.#fps = fps;
    this.#sampleRate = sampleRate;
  }

  /** ~59.63 for CPS-1, ~59.19 for Neo Geo. The accumulator exists for this. */
  get fps(): number {
    return this.#fps;
  }

  /** 48002.15, not 48000. The audio ring has to absorb the difference. */
  get sampleRate(): number {
    return this.#sampleRate;
  }

  get loaded(): boolean {
    return this.#loaded;
  }

  /** Latch one port's buttons. Must be called before runFrame(), not during. */
  setInput(port: number, mask: number): void {
    this.#m._fe_set_input(port, mask);
  }

  /** Advance exactly one emulated frame. Synchronous, ~0.5ms. */
  runFrame(): void {
    this.#m._retro_run();
  }

  video(): VideoFrame {
    const m = this.#m;
    const ptr = m._fe_fb();
    const height = m._fe_h();
    const pitch = m._fe_pitch();
    return {
      // subarray, not slice: no copy, and HEAPU8 is re-read so a memory growth
      // between frames cannot hand us a detached view.
      pixels: m.HEAPU8.subarray(ptr, ptr + pitch * height),
      width: m._fe_w(),
      height,
      pitch,
      format: m._fe_pixfmt(),
    };
  }

  /** Interleaved stereo int16 produced by the frame we just ran. */
  audio(): Int16Array {
    const m = this.#m;
    const ptr = m._fe_audio();
    const frames = m._fe_audio_frames();
    return new Int16Array(m.HEAP16.buffer, ptr, frames * 2);
  }

  /** Published by the core during the first runFrame(), not before. */
  descriptors(): InputDescriptor[] {
    const m = this.#m;
    const portOut = m._malloc(4);
    const idOut = m._malloc(4);
    try {
      const out: InputDescriptor[] = [];
      for (let i = 0; i < m._fe_ndesc(); i += 1) {
        const namePtr = m._fe_desc(i, portOut, idOut);
        if (!namePtr) break;
        out.push({
          name: m.UTF8ToString(namePtr),
          port: m.HEAPU32[portOut >> 2] ?? 0,
          id: m.HEAPU32[idOut >> 2] ?? 0,
        });
      }
      return out;
    } finally {
      m._free(portOut);
      m._free(idOut);
    }
  }

  reset(): void {
    this.#m._retro_reset();
  }

  /**
   * Not used by V1 — the host is authoritative, so there is nothing to
   * reconcile. Exposed because it is the single thing V2 rollback cannot be
   * built without, and it costs nothing to surface now: 276KB, deterministic.
   */
  serialize(): Uint8Array {
    const m = this.#m;
    const size = m._retro_serialize_size();
    if (this.#stateSize !== size) {
      if (this.#stateBuf) m._free(this.#stateBuf);
      this.#stateBuf = m._malloc(size);
      this.#stateSize = size;
    }
    if (!m._retro_serialize(this.#stateBuf, size)) throw new Error('retro_serialize failed');
    return m.HEAPU8.slice(this.#stateBuf, this.#stateBuf + size);
  }

  unserialize(state: Uint8Array): boolean {
    const m = this.#m;
    const ptr = m._malloc(state.length);
    try {
      m.HEAPU8.set(state, ptr);
      return m._retro_unserialize(ptr, state.length) !== 0;
    } finally {
      m._free(ptr);
    }
  }
}
