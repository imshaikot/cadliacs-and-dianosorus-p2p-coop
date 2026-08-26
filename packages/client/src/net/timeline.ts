import { MAX_PLAYERS } from '@dino/shared';

/**
 * Every peer's input, indexed by frame.
 *
 * A ring rather than a map: entries are written once, read once, and become
 * irrelevant a fraction of a second later. 1024 frames is ~17 seconds, far more
 * than the input delay plus history plus any plausible stall.
 *
 * Each slot carries the frame number it was written for, so a stale entry from
 * a previous lap of the ring can never be mistaken for a present one — which
 * matters, because "do I have this input yet" is the question the whole
 * lockstep clock turns on.
 */
export const TIMELINE_FRAMES = 1024;

export class InputTimeline {
  #masks = new Uint16Array(TIMELINE_FRAMES * MAX_PLAYERS);
  #stamps = new Int32Array(TIMELINE_FRAMES * MAX_PLAYERS);
  #newest = new Int32Array(MAX_PLAYERS);

  constructor() {
    this.clear();
  }

  clear(): void {
    this.#stamps.fill(-1);
    this.#masks.fill(0);
    this.#newest.fill(-1);
  }

  #index(frame: number, port: number): number {
    return (((frame % TIMELINE_FRAMES) + TIMELINE_FRAMES) % TIMELINE_FRAMES) * MAX_PLAYERS + port;
  }

  set(frame: number, port: number, mask: number): void {
    if (port < 0 || port >= MAX_PLAYERS || frame < 0) return;
    const i = this.#index(frame, port);
    // Never let an older packet overwrite a newer one for the same slot.
    if ((this.#stamps[i] ?? -1) > frame) return;
    this.#stamps[i] = frame;
    this.#masks[i] = mask;
    if (frame > (this.#newest[port] ?? -1)) this.#newest[port] = frame;
  }

  has(frame: number, port: number): boolean {
    return this.#stamps[this.#index(frame, port)] === frame;
  }

  get(frame: number, port: number): number {
    const i = this.#index(frame, port);
    return this.#stamps[i] === frame ? (this.#masks[i] ?? 0) : 0;
  }

  hasAll(frame: number, ports: readonly number[]): boolean {
    for (const port of ports) {
      if (!this.has(frame, port)) return false;
    }
    return true;
  }

  /** Highest frame we hold for a port, or -1. Drives the HUD's "how far ahead". */
  newestFor(port: number): number {
    return this.#newest[port] ?? -1;
  }

  /** Which of `ports` is missing input for `frame`. For diagnostics. */
  missingAt(frame: number, ports: readonly number[]): number[] {
    return ports.filter((p) => !this.has(frame, p));
  }
}
