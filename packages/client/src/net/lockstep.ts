import {
  INPUT_HISTORY_FRAMES,
  MAX_PLAYERS,
  decodeInput,
  encodeInput,
} from '@dino/shared';
import type { PeerId, Transport } from '@dino/shared';

import type { InputLatch } from '../emulator/input.js';
import { InputTimeline } from './timeline.js';

/**
 * Deterministic lockstep.
 *
 * Every peer runs the same emulator. Frame F is simulated only once every live
 * port's input for F is in hand, so all peers necessarily compute the same
 * frame — we verified the core is bit-identical across instances given
 * identical input, video and audio, over 6000 frames.
 *
 * The price is input delay. Local input sampled while simulating frame F is
 * scheduled for frame F + delay, which gives it `delay` frames of travel time.
 * Set the delay above the worst one-way latency and nobody ever waits; set it
 * below and everybody stalls together until the straggler's packet lands.
 *
 * This deliberately does not predict or roll back. The pieces rollback needs —
 * a frame-indexed timeline, per-frame latching, redundant input history — are
 * all here, so V2 adds prediction and a state ring rather than rewriting this.
 */
export interface LockstepOptions {
  transport: Transport;
  /** Emulator port this peer drives: 0, 1 or 2. */
  selfPort: number;
  latch: InputLatch;
  delayFrames: number;
  onStallChange?: (stalled: boolean, waitingFor: number[]) => void;
  /**
   * How long to wait on a silent peer before declaring it gone.
   *
   * This is the backstop that makes disconnects survivable no matter what the
   * transport does or does not notice. Without it, one peer closing its laptop
   * lid freezes the game for everybody until an ICE timeout eventually fires —
   * or forever, if it never does.
   */
  peerTimeoutMs: number;
  onPeerTimeout?: (ports: number[], stalledMs: number) => void;
}

export interface LockstepStats {
  frame: number;
  running: boolean;
  ports: number[];
  delayFrames: number;
  /** Times we could not advance because someone's input had not arrived. */
  stalls: number;
  /** Frames' worth of wall time lost to those stalls. */
  stalledFrames: number;
  /** Currently blocked on these ports, empty when healthy. */
  waitingFor: number[];
  /** How far ahead of the simulated frame each port's input reaches. */
  leadByPort: Record<number, number>;
  packetsIn: number;
  packetsOut: number;
  bytesIn: number;
  bytesOut: number;
}

export class Lockstep {
  readonly timeline = new InputTimeline();
  #transport: Transport;
  #selfPort: number;
  #latch: InputLatch;
  #delay: number;
  #onStallChange: ((stalled: boolean, waitingFor: number[]) => void) | undefined;
  #peerTimeoutMs: number;
  #onPeerTimeout: ((ports: number[], stalledMs: number) => void) | undefined;
  #stallSince = 0;

  #ports: number[] = [];
  #running = false;
  #publishedThrough = -1;
  #stalls = 0;
  #stalledFrames = 0;
  #wasStalled = false;
  #waitingFor: number[] = [];
  #packetsIn = 0;
  #packetsOut = 0;
  #bytesIn = 0;
  #bytesOut = 0;
  #scratch = new Uint16Array(MAX_PLAYERS);
  #history = new Uint16Array(INPUT_HISTORY_FRAMES);

  constructor(options: LockstepOptions) {
    this.#transport = options.transport;
    this.#selfPort = options.selfPort;
    this.#latch = options.latch;
    this.#delay = Math.max(1, options.delayFrames);
    this.#onStallChange = options.onStallChange;
    this.#peerTimeoutMs = options.peerTimeoutMs;
    this.#onPeerTimeout = options.onPeerTimeout;
  }

  get running(): boolean {
    return this.#running;
  }
  get ports(): number[] {
    return [...this.#ports];
  }
  get selfPort(): number {
    return this.#selfPort;
  }
  get delayFrames(): number {
    return this.#delay;
  }

  /**
   * Enter lockstep at `frame` with exactly `ports` live.
   *
   * Called on every membership change, always from a state all peers share, so
   * nobody has to reason about when a departed peer stopped sending.
   */
  begin(frame: number, ports: number[], delayFrames = this.#delay): void {
    this.#delay = Math.max(1, delayFrames);
    this.#ports = [...ports].sort((a, b) => a - b);
    this.timeline.clear();
    this.#publishedThrough = frame - 1;
    this.#waitingFor = [];
    this.#wasStalled = false;
    this.#stallSince = 0;

    // Nobody has pressed anything for the first `delay` frames yet, by
    // definition — those frames are already in flight. Publish them as neutral
    // so every peer can start immediately instead of deadlocking on frame one.
    for (let f = frame; f < frame + this.#delay; f += 1) {
      this.timeline.set(f, this.#selfPort, 0);
    }
    this.#publishedThrough = frame + this.#delay - 1;
    this.#sendFrom(this.#publishedThrough, this.#delay);
    this.#running = true;
  }

  stop(): void {
    this.#running = false;
    this.#ports = [];
    this.#waitingFor = [];
  }

  /**
   * The frame driver. Returns the per-port masks for `frame`, or null to say
   * "not yet" — in which case the emulator must not advance.
   */
  inputsFor(frame: number): Uint16Array | null {
    if (!this.#running) return null;

    // Sample our own input exactly once per simulated frame (gotcha #9) and
    // schedule it `delay` frames out. Doing this before the availability check
    // matters: it keeps us publishing even while we are stalled on someone
    // else, which is what stops two stalled peers deadlocking on each other.
    this.#publish(frame + this.#delay);

    if (!this.timeline.hasAll(frame, this.#ports)) {
      this.#stalls += 1;
      this.#waitingFor = this.timeline.missingAt(frame, this.#ports);
      const now = performance.now();
      if (!this.#wasStalled) {
        this.#wasStalled = true;
        this.#stallSince = now;
        this.#onStallChange?.(true, this.#waitingFor);
      } else if (this.#stallSince > 0 && now - this.#stallSince > this.#peerTimeoutMs) {
        const stalledMs = now - this.#stallSince;
        // Fire once, then hold off: the handler will resync or go solo, and
        // repeating every frame would stampede it.
        this.#stallSince = 0;
        this.#onPeerTimeout?.([...this.#waitingFor], stalledMs);
      }
      return null;
    }

    if (this.#wasStalled) {
      this.#wasStalled = false;
      this.#stallSince = 0;
      this.#waitingFor = [];
      this.#onStallChange?.(false, []);
    }

    this.#scratch.fill(0);
    for (const port of this.#ports) this.#scratch[port] = this.timeline.get(frame, port);
    return this.#scratch;
  }

  /** Counts wall time lost while blocked, for the HUD. */
  noteStalledFrame(): void {
    this.#stalledFrames += 1;
  }

  #publish(target: number): void {
    if (target <= this.#publishedThrough) return;
    // Fill any gap, so a hitch in the render loop cannot leave holes that would
    // stall every other peer.
    for (let f = this.#publishedThrough + 1; f < target; f += 1) {
      this.timeline.set(f, this.#selfPort, 0);
    }
    this.timeline.set(target, this.#selfPort, this.#latch.latch());
    this.#publishedThrough = target;
    this.#sendFrom(target, INPUT_HISTORY_FRAMES);
  }

  #sendFrom(baseFrame: number, count: number): void {
    const n = Math.max(1, Math.min(count, 255));
    const masks = n === INPUT_HISTORY_FRAMES ? this.#history : new Uint16Array(n);
    for (let i = 0; i < n; i += 1) {
      const f = baseFrame - i;
      masks[i] = f >= 0 ? this.timeline.get(f, this.#selfPort) : 0;
    }
    const packet = encodeInput(this.#selfPort, baseFrame, masks.subarray(0, n));
    this.#transport.sendInput(packet);
    this.#packetsOut += 1;
    this.#bytesOut += packet.byteLength;
  }

  /** Feed every inbound input packet here. Unknown kinds are ignored. */
  acceptInput(_from: PeerId, bytes: Uint8Array): boolean {
    const packet = decodeInput(bytes);
    if (!packet) return false;
    this.#packetsIn += 1;
    this.#bytesIn += bytes.byteLength;
    // Our own port never arrives from the wire; ignoring it defends against a
    // peer with a stale roster clobbering our authoritative local input.
    if (packet.port === this.#selfPort) return true;
    for (let i = 0; i < packet.masks.length; i += 1) {
      const frame = packet.baseFrame - i;
      if (frame < 0) break;
      this.timeline.set(frame, packet.port, packet.masks[i] ?? 0);
    }
    return true;
  }

  stats(frame: number): LockstepStats {
    const leadByPort: Record<number, number> = {};
    for (const port of this.#ports) leadByPort[port] = this.timeline.newestFor(port) - frame;
    return {
      frame,
      running: this.#running,
      ports: [...this.#ports],
      delayFrames: this.#delay,
      stalls: this.#stalls,
      stalledFrames: this.#stalledFrames,
      waitingFor: [...this.#waitingFor],
      leadByPort,
      packetsIn: this.#packetsIn,
      packetsOut: this.#packetsOut,
      bytesIn: this.#bytesIn,
      bytesOut: this.#bytesOut,
    };
  }
}
