import { Signal } from '@dino/shared';

import { EmulatorAudio } from './audio.js';
import type { AudioStats } from './audio.js';
import { FbneoCore } from './fbneo.js';
import { InputLatch } from './input.js';
import { Renderer } from './renderer.js';

/** Player 1 is the host; guests drive 2 and 3. Ports are zero-based. */
export const PORT_COUNT = 3;

export interface MachineStats {
  /** Emulated frames since boot. */
  frames: number;
  /** Authoritative frame number. Shared across peers when in lockstep. */
  frame: number;
  /** True when the driver is withholding permission to advance. */
  stalled: boolean;
  /** rAF pumps that ended with no frame run because of a stall. */
  stalledPumps: number;
  /** Measured emulation rate over the last second. Should sit at ~59.6. */
  emulatedFps: number;
  /** Rolling mean cost of one core.runFrame(), milliseconds. */
  frameTimeMs: number;
  /** Frames the accumulator gave up on because we could not catch up. */
  droppedCatchUp: number;
  /** Canvas presents. Lower than `frames` only if we ever skip rendering. */
  presented: number;
  audio: AudioStats;
}

/**
 * Decides what input a frame runs with, and — by returning null — whether it
 * runs at all. Solo play has no driver and free-runs off the wall clock;
 * lockstep installs one and the emulator then advances only at the rate
 * consensus allows.
 */
export interface FrameDriver {
  inputsFor(frame: number): Uint16Array | null;
  noteStalledFrame?: () => void;
}

export interface MachineOptions {
  canvas?: HTMLCanvasElement;
  onLog?: (line: string) => void;
}

/**
 * Owns the emulator's clock.
 *
 * Gotcha #11: CPS-1 runs at 59.63Hz, so requestAnimationFrame alone is wrong —
 * it fires at the display's rate, which is 60Hz, or 120Hz, or whatever the
 * user's monitor happens to be. rAF is used only as a pump; an accumulator
 * decides how many emulated frames actually belong to the elapsed wall time.
 *
 * Gotcha #9: inputs are latched exactly once per emulated frame, immediately
 * before running it. Nothing is applied asynchronously as it arrives. That is
 * why M3 can drop network input straight into these same latches.
 */
export class Machine {
  readonly core: FbneoCore;
  readonly renderer: Renderer;
  readonly audio = new EmulatorAudio();
  /** One latch per emulator port. Port 0 is the host's keyboard; 1 and 2 are
   *  filled from the network in M3. */
  readonly latches: InputLatch[] = Array.from({ length: PORT_COUNT }, () => new InputLatch());

  #onLog: ((line: string) => void) | undefined;
  /**
   * Fires after each simulated frame, with the frame number just completed.
   *
   * A signal rather than a single callback because two things legitimately want
   * it at once: desync detection checksums the state here, and verification
   * hangs its own frame probe off the same hook. One slot would mean whichever
   * registered last silently won.
   */
  readonly frameAdvanced = new Signal<[number]>();
  /**
   * Runs immediately before each frame latches its input.
   *
   * A gamepad is a polled device with no press events, so something has to go
   * and read it. Doing that from rAF would repeat gotcha #11 one layer up: it
   * samples at the display's rate rather than the emulator's, and it stops dead
   * in a backgrounded tab — where, under lockstep, a frozen stick is published
   * to every other peer. Hanging it here instead puts the pad on exactly the
   * same once-per-emulated-frame cadence as the keyboard latch.
   */
  onBeforeFrame: (() => void) | null = null;
  #raf = 0;
  #running = false;
  #last = 0;
  #accumulator = 0;
  #frameMs = 1000 / 59.63;

  #frames = 0;
  #frame = 0;
  #driver: FrameDriver | null = null;
  #stalled = false;
  #stalledPumps = 0;
  #droppedCatchUp = 0;
  #frameTimeMs = 0;
  #fpsWindowStart = 0;
  #fpsWindowFrames = 0;
  #emulatedFps = 0;
  /**
   * A one-second window holds ~60 whole frames, so it can only ever report 59
   * or 60 — which blurs precisely the distinction that matters here. Three
   * seconds plus light smoothing resolves 59.63 from 60.00.
   */
  static readonly FPS_WINDOW_MS = 3000;
  #statsTick = 0;

  /** Beyond this many frames of debt we stop trying to catch up and reset the
   *  accumulator, rather than spiralling into a death loop after a stall. */
  static readonly MAX_CATCH_UP = 6;
  /** A gap this large means the tab was suspended, not that we fell behind. */
  static readonly STALL_MS = 250;

  private constructor(core: FbneoCore, renderer: Renderer, onLog?: (line: string) => void) {
    this.core = core;
    this.renderer = renderer;
    this.#onLog = onLog;
  }

  static async boot(options: MachineOptions = {}): Promise<Machine> {
    const core = await FbneoCore.load(options.onLog);
    const renderer = new Renderer(options.canvas);
    return new Machine(core, renderer, options.onLog);
  }

  loadRom(fileName: string, bytes: Uint8Array): void {
    this.core.loadRom(fileName, bytes);
    this.#frameMs = 1000 / this.core.fps;
    this.#onLog?.(
      `core reports ${this.core.fps.toFixed(2)}Hz and ${this.core.sampleRate.toFixed(2)}Hz audio`,
    );
  }

  get running(): boolean {
    return this.#running;
  }

  get frame(): number {
    return this.#frame;
  }

  /** Install lockstep, or pass null to go back to free-running solo play. */
  setDriver(driver: FrameDriver | null, startFrame = this.#frame): void {
    this.#driver = driver;
    this.#frame = startFrame;
    this.#stalled = false;
    this.#accumulator = 0;
  }

  get stats(): MachineStats {
    return {
      frames: this.#frames,
      frame: this.#frame,
      stalled: this.#stalled,
      stalledPumps: this.#stalledPumps,
      emulatedFps: this.#emulatedFps,
      frameTimeMs: this.#frameTimeMs,
      droppedCatchUp: this.#droppedCatchUp,
      presented: this.renderer.frameCount,
      audio: this.audio.stats,
    };
  }

  /** Call from a user gesture: starting audio requires one. */
  async start(): Promise<void> {
    if (this.#running) return;
    if (!this.core.loaded) throw new Error('no ROM loaded');
    await this.audio.start();
    // The audio thread is the clock of record; rAF is a second, nicer-aligned
    // pump for when the tab is actually on screen. Both call the same
    // accumulator, which is inherently safe against being driven twice: each
    // call only ever spends the wall time that has genuinely elapsed.
    this.audio.onTick = () => this.#advance(performance.now());
    this.#running = true;
    this.#emulatedFps = 0;
    this.#last = performance.now();
    this.#fpsWindowStart = this.#last;
    this.#fpsWindowFrames = 0;
    this.#accumulator = 0;
    this.#raf = requestAnimationFrame(this.#pump);
  }

  stop(): void {
    this.#running = false;
    this.audio.onTick = null;
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    for (const latch of this.latches) latch.clear();
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.audio.close();
  }

  #pump = (now: number): void => {
    if (!this.#running) return;
    this.#raf = requestAnimationFrame(this.#pump);
    this.#advance(now);
  };

  #advance(now: number): void {
    if (!this.#running) return;

    let delta = now - this.#last;
    this.#last = now;
    // A backgrounded tab hands us a huge delta on return. Running a thousand
    // catch-up frames would be worse than admitting we lost the time.
    if (delta > Machine.STALL_MS) delta = this.#frameMs;
    this.#accumulator += delta;

    let ran = 0;
    let blocked = false;
    while (this.#accumulator >= this.#frameMs && ran < Machine.MAX_CATCH_UP) {
      if (!this.#step()) {
        blocked = true;
        break;
      }
      this.#accumulator -= this.#frameMs;
      ran += 1;
    }
    if (blocked) {
      // Wall time keeps passing while we wait on a peer, but that time is not a
      // debt to repay — in lockstep the clock IS consensus, not the wall. Let
      // the accumulator bank one frame so we resume instantly, and no more, so
      // we resume at 1x rather than sprinting through the backlog.
      this.#accumulator = Math.min(this.#accumulator, this.#frameMs);
      this.#stalledPumps += 1;
      this.#driver?.noteStalledFrame?.();
    } else if (ran === Machine.MAX_CATCH_UP && this.#accumulator >= this.#frameMs) {
      this.#droppedCatchUp += Math.floor(this.#accumulator / this.#frameMs);
      this.#accumulator = 0;
    }
    this.#stalled = blocked;

    // Only the newest frame is worth showing; intermediate catch-up frames are
    // emulated but never presented.
    if (ran > 0) this.renderer.present(this.core.video());

    this.#fpsWindowFrames += ran;
    if (now - this.#fpsWindowStart >= Machine.FPS_WINDOW_MS) {
      const measured = (this.#fpsWindowFrames * 1000) / (now - this.#fpsWindowStart);
      this.#emulatedFps = this.#emulatedFps === 0 ? measured : this.#emulatedFps * 0.5 + measured * 0.5;
      this.#fpsWindowStart = now;
      this.#fpsWindowFrames = 0;
    }
    if (now - this.#statsTick >= 500) {
      this.#statsTick = now;
      this.audio.requestStats();
    }
  }

  /**
   * Exactly one emulated frame: latch, run, drain audio.
   * Returns false if the driver withheld permission, in which case nothing
   * happened and the emulator has not advanced.
   */
  #step(): boolean {
    this.onBeforeFrame?.();
    const masks = this.#driver ? this.#driver.inputsFor(this.#frame) : this.#soloMasks();
    if (!masks) return false;
    for (let port = 0; port < PORT_COUNT; port += 1) {
      this.core.setInput(port, masks[port] ?? 0);
    }
    const t0 = performance.now();
    this.core.runFrame();
    const cost = performance.now() - t0;
    // Cheap exponential mean; we only ever look at this to answer "are we
    // anywhere near the budget", not for precision.
    this.#frameTimeMs = this.#frameTimeMs === 0 ? cost : this.#frameTimeMs * 0.95 + cost * 0.05;
    this.audio.push(this.core.audio());
    this.#frames += 1;
    this.#frame += 1;
    this.frameAdvanced.emit(this.#frame - 1);
    return true;
  }

  /** Solo play: this peer's keyboard drives port 0, the rest sit neutral. */
  #soloMasks(): Uint16Array {
    for (let port = 0; port < PORT_COUNT; port += 1) {
      this.#soloScratch[port] = (this.latches[port] as InputLatch).latch();
    }
    return this.#soloScratch;
  }

  #soloScratch = new Uint16Array(PORT_COUNT);
}
