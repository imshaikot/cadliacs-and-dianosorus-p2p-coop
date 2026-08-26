import createFBNeo from './core/fbneo_cps12.mjs';
import type { FbneoWasm } from './core/fbneo_cps12.mjs';
import wasmUrl from './core/fbneo_cps12.wasm?url';

/**
 * Thin typed skin over the WASM core. Deliberately owns no timing and no
 * policy: it exposes one-frame-at-a-time execution and nothing else, because
 * the whole netcode design depends on us deciding when a frame happens.
 */

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
  #m: FbneoWasm;
  #fps = 0;
  #sampleRate = 0;
  #loaded = false;
  #stateBuf = 0;
  #stateSize = 0;

  private constructor(module: FbneoWasm) {
    this.#m = module;
  }

  static async load(onLog?: (line: string) => void): Promise<FbneoCore> {
    const module = await createFBNeo({
      // Vite rewrites the .wasm to a hashed asset URL; without this the
      // Emscripten glue would look for it next to the .mjs and 404 in prod.
      locateFile: () => wasmUrl,
      print: (t) => onLog?.(t),
      printErr: (t) => onLog?.(t),
    });
    module._fe_install();
    module._retro_init();
    return new FbneoCore(module);
  }

  /**
   * FBNeo sets `need_fullpath` and `block_extract`, so it will not accept a
   * buffer — it wants a path and opens the zip itself. We hand it one inside
   * the Emscripten in-memory filesystem. Nothing touches the network, and the
   * driver is chosen purely from the basename: dino.zip -> driver `dino`.
   */
  loadRom(fileName: string, bytes: Uint8Array): void {
    if (this.#loaded) throw new Error('a ROM is already loaded');
    const m = this.#m;
    for (const dir of ['/roms', '/fbneo', '/fbneo/system', '/fbneo/save']) {
      if (!m.FS.analyzePath(dir).exists) m.FS.mkdir(dir);
    }
    const path = `/roms/${fileName}`;
    m.FS.writeFile(path, bytes);
    const ptr = m.stringToNewUTF8(path);
    try {
      if (!m._fe_load(ptr)) throw new Error(`FBNeo refused to load ${fileName}`);
    } finally {
      m._free(ptr);
    }
    this.#loaded = true;
    this.#fps = m._fe_fps();
    this.#sampleRate = m._fe_srate();
  }

  /** ~59.63 for CPS-1, which is the entire reason for the accumulator. */
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
