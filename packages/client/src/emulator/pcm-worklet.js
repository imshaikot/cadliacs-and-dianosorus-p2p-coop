/**
 * Emulator PCM sink.
 *
 * Plain JS on purpose: this is loaded with `audioWorklet.addModule()` and runs
 * on the audio thread, so it is emitted as a standalone asset rather than
 * bundled with the app.
 *
 * The emulator produces audio in bursts — one chunk of ~805 stereo frames per
 * emulated frame — while the audio thread consumes a steady 128 frames per
 * call. A ring buffer between them absorbs that, plus two kinds of drift:
 *
 *  - FBNeo reports a sample rate of 48002.15Hz (59.63 frames/s x 805 samples),
 *    not 48000. Feeding that into a 48000Hz context adds ~2.15 samples every
 *    second, so the buffer creeps upward forever if nothing corrects it.
 *  - The emulator loop is paced by wall clock, so it will also drift a little
 *    against the audio clock in either direction.
 *
 * Rather than resample, the buffer steers itself back to a target fill level by
 * dropping or repeating a single frame at a time. At 48kHz one frame is 20
 * microseconds; you cannot hear it, and it never accumulates.
 */
const CAPACITY_FRAMES = 16384; // ~340ms of stereo at 48kHz
const TARGET_FRAMES = 2400; // ~50ms, about three emulated frames of slack
const TOLERANCE = 400; // ~8ms deadband around the target
/**
 * Minimum quanta between two corrections.
 *
 * Without this the loop oscillates. Each correction moves the true fill by one
 * sample, but the EMA it is judged against lags by ~250ms, so once the average
 * strays outside the deadband every single quantum corrects for a quarter of a
 * second, overshoots, and then spends the next quarter second correcting back —
 * hundreds of adjustments per second to fix a drift of about fifteen.
 *
 * One correction per 16 quanta caps the authority at ~23 samples/s. Real drift
 * is the core's 48002.15Hz against a 48000Hz sink plus loop jitter, on the
 * order of 15/s, so this still has margin while making oscillation impossible.
 */
const CORRECTION_INTERVAL = 16;
/**
 * Steering has to act on a SMOOTHED fill level, not the instantaneous one.
 *
 * The producer pushes one 805-frame chunk per emulated frame while the consumer
 * drains 128 frames per quantum, so the true fill sawtooths across an 805-frame
 * range every 16.77ms. Comparing that raw value against a deadband narrower
 * than the sawtooth makes the buffer look starved at the trough and flooded at
 * the peak within the same cycle, and it then fights itself — repeating and
 * dropping samples continuously while the average sits exactly on target.
 * An EMA over ~250ms flattens the sawtooth and leaves only real drift.
 */
const FILL_EMA = 0.01;

class PcmSink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(CAPACITY_FRAMES);
    this.right = new Float32Array(CAPACITY_FRAMES);
    this.read = 0;
    this.write = 0;
    this.underruns = 0;
    this.dropped = 0;
    this.repeated = 0;
    this.avgFill = TARGET_FRAMES;
    /**
     * The buffer cannot fill itself.
     *
     * Production and consumption are both ~48000 samples/s by design, so
     * starting playback immediately locks the buffer in at whatever it had at
     * frame one — which is nothing. Steering would then spend six seconds
     * repeating one sample per quantum to claw its way to the target, which is
     * both audible and exactly the "constant correction" symptom. Instead, hold
     * the read pointer still until there is a target's worth of audio banked.
     * At full production rate that takes about 50ms of silence, once.
     */
    this.primed = false;
    this.sinceCorrection = CORRECTION_INTERVAL;
    this.running = true;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d === 'stop') {
        this.running = false;
        return;
      }
      if (d === 'stats') {
        this.port.postMessage({
          fill: Math.round(this.avgFill),
          primed: this.primed,
          underruns: this.underruns,
          dropped: this.dropped,
          repeated: this.repeated,
        });
        return;
      }
      this.push(d);
    };
  }

  fill() {
    return (this.write - this.read + CAPACITY_FRAMES) % CAPACITY_FRAMES;
  }

  /** `interleaved` is stereo int16 already scaled to float by the main thread. */
  push(interleaved) {
    const frames = interleaved.length >> 1;
    let free = CAPACITY_FRAMES - 1 - this.fill();
    if (frames > free) {
      // Genuine overrun, not drift: the consumer has stalled. Drop the oldest
      // audio rather than the newest, so we stay close to live.
      const discard = frames - free;
      this.read = (this.read + discard) % CAPACITY_FRAMES;
      this.dropped += discard;
      free = CAPACITY_FRAMES - 1 - this.fill();
    }
    let w = this.write;
    for (let i = 0, j = 0; i < frames; i += 1, j += 2) {
      this.left[w] = interleaved[j];
      this.right[w] = interleaved[j + 1];
      w = w + 1 === CAPACITY_FRAMES ? 0 : w + 1;
    }
    this.write = w;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return this.running;
    const l = out[0];
    const r = out[1] ?? out[0];
    const n = l.length;

    const fill = this.fill();
    this.avgFill += (fill - this.avgFill) * FILL_EMA;

    if (!this.primed) {
      // Banking the initial buffer. Not an underrun — nothing has gone wrong.
      if (fill < TARGET_FRAMES) {
        l.fill(0);
        if (r !== l) r.fill(0);
        return this.running;
      }
      this.primed = true;
      this.avgFill = fill;
    }

    if (fill < n) {
      // Underrun: emit silence rather than stale audio, and say so. Re-prime,
      // because limping along one repeated sample at a time from empty is worse
      // than one more moment of silence.
      l.fill(0);
      if (r !== l) r.fill(0);
      this.underruns += 1;
      this.primed = false;
      return this.running;
    }

    // Gentle drift steering: at most one sample, and not every quantum.
    let skip = 0;
    let hold = 0;
    this.sinceCorrection += 1;
    if (this.sinceCorrection >= CORRECTION_INTERVAL) {
      if (this.avgFill > TARGET_FRAMES + TOLERANCE && fill > n + 1) skip = 1;
      else if (this.avgFill < TARGET_FRAMES - TOLERANCE) hold = 1;
      if (skip || hold) this.sinceCorrection = 0;
    }

    let p = this.read;
    for (let i = 0; i < n; i += 1) {
      l[i] = this.left[p];
      r[i] = this.right[p];
      if (hold === 1 && i === 0) {
        hold = 0;
        this.repeated += 1;
        continue; // reuse this sample once more, do not advance
      }
      p = p + 1 === CAPACITY_FRAMES ? 0 : p + 1;
    }
    if (skip === 1) {
      p = p + 1 === CAPACITY_FRAMES ? 0 : p + 1;
      this.dropped += 1;
    }
    this.read = p;
    return this.running;
  }
}

registerProcessor('pcm-sink', PcmSink);
