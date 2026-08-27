import { PIXEL_RGB565, PIXEL_XRGB8888 } from './fbneo.js';
import type { VideoFrame } from './fbneo.js';

/**
 * Blits the core's framebuffer to a 2D canvas.
 *
 * A 2D canvas rather than WebGL, on purpose. Measured cost of the whole path
 * (format conversion + putImageData + 3x upscale) is 0.079ms/frame, 0.47% of
 * the 16.78ms budget at 384x224 — WebGL buys nothing here, and it would
 * reintroduce the captureStream black-frame hazard that M2 depends on avoiding.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #image: ImageData | null = null;
  #rgba: Uint32Array | null = null;
  #width = 0;
  #height = 0;
  #frames = 0;

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement('canvas');
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('could not get a 2D context for the emulator canvas');
    ctx.imageSmoothingEnabled = false;
    this.#ctx = ctx;
  }

  get frameCount(): number {
    return this.#frames;
  }

  present(frame: VideoFrame): void {
    if (frame.width === 0 || frame.height === 0) return;
    this.#ensureSize(frame.width, frame.height);
    const rgba = this.#rgba;
    const image = this.#image;
    if (!rgba || !image) return;

    if (frame.format === PIXEL_XRGB8888) {
      convertXrgb8888(frame, rgba);
    } else if (frame.format === PIXEL_RGB565) {
      convertRgb565(frame, rgba);
    } else {
      throw new Error(`unsupported pixel format ${frame.format}`);
    }

    this.#ctx.putImageData(image, 0, 0);
    this.#frames += 1;
  }

  #ensureSize(width: number, height: number): void {
    if (this.#width === width && this.#height === height) return;
    this.#width = width;
    this.#height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.#ctx.imageSmoothingEnabled = false;
    this.#image = this.#ctx.createImageData(width, height);
    this.#rgba = new Uint32Array(this.#image.data.buffer);
  }
}

const ALPHA = 0xff000000;

/**
 * XRGB8888 is documented as "native endian, most significant byte ignored", so
 * on a little-endian machine a u32 read gives 0x00RRGGBB while canvas RGBA
 * wants 0xAABBGGRR. That is a red/blue swap, not a straight copy.
 */
function convertXrgb8888(frame: VideoFrame, out: Uint32Array): void {
  const src = new Uint32Array(
    frame.pixels.buffer,
    frame.pixels.byteOffset,
    (frame.pitch * frame.height) >> 2,
  );
  const stride = frame.pitch >> 2;
  const { width, height } = frame;
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    let s = y * stride;
    for (let x = 0; x < width; x += 1, s += 1, o += 1) {
      const p = src[s] as number;
      out[o] = ALPHA | ((p & 0xff) << 16) | (p & 0xff00) | ((p >> 16) & 0xff);
    }
  }
}

const R5 = new Uint32Array(32);
const G6 = new Uint32Array(64);
const B5 = new Uint32Array(32);
for (let i = 0; i < 32; i += 1) {
  const v = (i << 3) | (i >> 2);
  R5[i] = v;
  B5[i] = v << 16;
}
for (let i = 0; i < 64; i += 1) G6[i] = (((i << 2) | (i >> 4)) & 0xff) << 8;

/** Not used by CPS-1/2, which negotiate XRGB8888, but cheap to keep correct. */
function convertRgb565(frame: VideoFrame, out: Uint32Array): void {
  const src = new Uint16Array(
    frame.pixels.buffer,
    frame.pixels.byteOffset,
    (frame.pitch * frame.height) >> 1,
  );
  const stride = frame.pitch >> 1;
  const { width, height } = frame;
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    let s = y * stride;
    for (let x = 0; x < width; x += 1, s += 1, o += 1) {
      const p = src[s] as number;
      out[o] = ALPHA | (B5[(p >> 11) & 31] as number) | (G6[(p >> 5) & 63] as number) | (R5[p & 31] as number);
    }
  }
}
