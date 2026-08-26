import workletUrl from './pcm-worklet.js?url';

export interface AudioStats {
  fill: number;
  /** False only while banking the initial buffer, or just after an underrun. */
  primed: boolean;
  underruns: number;
  dropped: number;
  repeated: number;
}

/**
 * Owns the AudioContext and the path from emulator PCM to the speakers.
 *
 * Two things it deliberately does NOT do: resample (the worklet steers instead,
 * see pcm-worklet.js), and start itself. Gotcha #6 — an AudioContext will not
 * run without a user gesture, so construction is cheap and `start()` must be
 * called from a click handler.
 *
 * `destination` is the tap M2 sends over WebRTC. It exists from the start so
 * that adding transport later is wiring, not surgery.
 */
export class EmulatorAudio {
  #ctx: AudioContext | null = null;
  #node: AudioWorkletNode | null = null;
  #tap: MediaStreamAudioDestinationNode | null = null;
  #scratch = new Float32Array(0);
  #stats: AudioStats = { fill: 0, primed: false, underruns: 0, dropped: 0, repeated: 0 };

  get context(): AudioContext | null {
    return this.#ctx;
  }

  get started(): boolean {
    return this.#node !== null;
  }

  /** The MediaStream carrying emulator audio. Null until start(). */
  get stream(): MediaStream | null {
    return this.#tap?.stream ?? null;
  }

  get stats(): AudioStats {
    return this.#stats;
  }

  /**
   * Must be called from a user gesture. `coreSampleRate` is what FBNeo reports
   * (48002.15 for CPS-1); we pin the context to a clean 48000 and let the
   * worklet absorb the difference, because AudioContext will not accept a
   * fractional rate and resampling every frame would cost more than it is worth.
   */
  async start(): Promise<void> {
    if (this.#node) return;
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, 'pcm-sink', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (e: MessageEvent<AudioStats>) => {
      this.#stats = e.data;
    };
    const tap = ctx.createMediaStreamDestination();
    node.connect(ctx.destination);
    node.connect(tap);
    if (ctx.state === 'suspended') await ctx.resume();
    this.#ctx = ctx;
    this.#node = node;
    this.#tap = tap;
  }

  /** Interleaved stereo int16 straight out of the core, once per frame. */
  push(pcm: Int16Array): void {
    const node = this.#node;
    if (!node || pcm.length === 0) return;
    if (this.#scratch.length !== pcm.length) this.#scratch = new Float32Array(pcm.length);
    const f = this.#scratch;
    for (let i = 0; i < pcm.length; i += 1) f[i] = (pcm[i] as number) / 32768;
    // Copy, not transfer: `pcm` is a view into WASM memory that the next frame
    // overwrites, and a transferred buffer would detach the core's heap.
    node.port.postMessage(f.slice());
  }

  requestStats(): void {
    this.#node?.port.postMessage('stats');
  }

  async close(): Promise<void> {
    this.#node?.port.postMessage('stop');
    this.#node?.disconnect();
    this.#tap?.disconnect();
    this.#node = null;
    this.#tap = null;
    const ctx = this.#ctx;
    this.#ctx = null;
    if (ctx && ctx.state !== 'closed') await ctx.close();
  }
}
