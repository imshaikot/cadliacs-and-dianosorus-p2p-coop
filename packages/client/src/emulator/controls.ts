/**
 * The local player's physical controls, whatever they happen to be.
 *
 * One object owns the keyboard listeners, the gamepad poll and the profile, and
 * pushes the result into exactly one InputLatch — the latch for whichever port
 * this peer drives. Everything downstream of the latch is unchanged: lockstep
 * still samples once per emulated frame and never learns that a stick exists.
 *
 * The keyboard is event-driven and the gamepad is not — the Gamepad API has no
 * events for button state, only a snapshot you have to go and read. That
 * difference is the only real complexity here, and it is why `poll()` is
 * separate and idempotent: the emulator calls it once per emulated frame (see
 * `Machine.onBeforeFrame`) and the controls panel calls it from rAF so that
 * remapping works before a ROM is even loaded. Both can run; neither is
 * damaged by the other.
 */
import { Signal } from '@retro/shared';

import {
  MAX_DEADZONE,
  MIN_DEADZONE,
  MIN_TRAVEL,
  NO_TRAVEL,
  clamp,
  correctAxis,
  defaultProfile,
  loadProfile,
  saveProfile,
  tokenOf,
} from './bindings.js';
import type { Binding, ControlProfile } from './bindings.js';
import { BUTTON_NAMES, bit, isTyping } from './input.js';
import type { ButtonName, InputLatch } from './input.js';

/** What the panel draws its meters from. Null when no pad is connected. */
export interface PadSnapshot {
  readonly index: number;
  readonly id: string;
  /** True when the browser recognised the device and remapped it to the
   *  standard layout, which is the only case where button names mean anything. */
  readonly standard: boolean;
  /** Straight from the device. */
  readonly raw: readonly number[];
  /** Rest-corrected — this is what the deadzone is compared against. */
  readonly corrected: readonly number[];
  readonly buttons: readonly boolean[];
}

/**
 * How far an axis must swing to be *captured* as a binding.
 *
 * Deliberately higher than any sane deadzone: rebinding is exactly when a
 * drifting stick would otherwise grab the slot the moment you opened the panel.
 */
const CAPTURE_AXIS_THRESHOLD = 0.6;
/** A pad button counts as pressed above this. Analogue triggers report a float. */
const BUTTON_THRESHOLD = 0.5;
/** Polls averaged by centring. About half a second of rest at frame rate. */
const CALIBRATION_SAMPLES = 30;

/**
 * What the two calibration phases are for.
 *
 * `centre` learns where the sticks sit untouched; `sweep` learns how far they
 * actually go. They are separate because they want opposite things from the
 * player — hands off, then hands on — and a single pass that tried to infer
 * both would have to guess which of the two a given sample was.
 */
export type CalibrationPhase = 'centre' | 'sweep';

export interface CalibrationState {
  readonly phase: CalibrationPhase;
  /** 0..1. Samples collected for `centre`; axes swept far enough for `sweep`. */
  readonly progress: number;
  /** Travel seen so far this sweep, per axis, either side of rest. */
  readonly travel: ReadonlyArray<readonly [number, number]>;
}

type CalibrationRun =
  | { phase: 'centre'; id: string; sum: number[]; lo: number[]; hi: number[]; samples: number }
  | { phase: 'sweep'; id: string; lo: number[]; hi: number[] };

interface Capture {
  resolve: (binding: Binding) => void;
  /** Pad controls already active when capture began, so a held stick or a
   *  still-depressed button cannot instantly claim the slot. */
  ignore: Set<string>;
}

export class LocalControls {
  /** Profile, pad connection or calibration changed. Not fired for presses. */
  readonly changed = new Signal<[]>();

  #profile: ControlProfile;
  /** token -> the button bits it drives. Rebuilt whenever the profile changes. */
  #index = new Map<string, number>();
  /** Every physical control currently down, keyboard and pad together. */
  #down = new Set<string>();
  #latch: InputLatch | null = null;
  #applied = 0;
  /**
   * Held, but not driving anything.
   *
   * Calibration asks the player to sweep both sticks into every corner. Doing
   * that while the game is live would run the character across the screen — and
   * under lockstep that is not a private embarrassment, it is published to
   * everyone. Suspending releases what is held and stops applying, without
   * forgetting which latch we belong to.
   */
  #suspended = false;

  #pad: PadSnapshot | null = null;
  #capture: Capture | null = null;
  #calibration: CalibrationRun | null = null;
  /**
   * How far the sticks wandered while the player was not touching them, from
   * the last centring pass. This is the only honest basis for a deadzone
   * suggestion: the number has to clear the noise this particular pad makes.
   */
  #jitter: number | null = null;

  constructor(profile: ControlProfile = loadProfile()) {
    this.#profile = profile;
    this.#reindex();
    window.addEventListener('keydown', this.#onKeyDown);
    window.addEventListener('keyup', this.#onKeyUp);
    window.addEventListener('blur', this.#onLeave);
    document.addEventListener('visibilitychange', this.#onLeave);
    window.addEventListener('gamepadconnected', this.#onPadChange);
    window.addEventListener('gamepaddisconnected', this.#onPadChange);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.#onKeyDown);
    window.removeEventListener('keyup', this.#onKeyUp);
    window.removeEventListener('blur', this.#onLeave);
    document.removeEventListener('visibilitychange', this.#onLeave);
    window.removeEventListener('gamepadconnected', this.#onPadChange);
    window.removeEventListener('gamepaddisconnected', this.#onPadChange);
    this.attach(null);
  }

  get profile(): ControlProfile {
    return this.#profile;
  }

  get pad(): PadSnapshot | null {
    return this.#pad;
  }

  get capturing(): boolean {
    return this.#capture !== null;
  }

  /** What calibration is doing right now, or null when it is doing nothing. */
  get calibration(): CalibrationState | null {
    const run = this.#calibration;
    if (!run) return null;
    if (run.phase === 'centre') {
      return { phase: 'centre', progress: run.samples / CALIBRATION_SAMPLES, travel: [] };
    }
    const travel = run.lo.map((lo, i) => [lo, run.hi[i] ?? 0] as const);
    const swept = travel.filter(([lo, hi]) => -lo >= MIN_TRAVEL && hi >= MIN_TRAVEL).length;
    return { phase: 'sweep', progress: travel.length ? swept / travel.length : 0, travel };
  }

  /** Worst resting wobble measured by the last centring pass, in axis units. */
  get restJitter(): number | null {
    return this.#jitter;
  }

  /**
   * A deadzone that clears this pad's own noise, with room to spare.
   *
   * Two and a half times the measured wobble, plus a floor: the multiplier is
   * headroom for the wobble being worse later than it was during the sample,
   * and the floor stops a suspiciously clean reading producing a deadzone so
   * tight that the first warm afternoon reintroduces drift.
   */
  get suggestedDeadzone(): number | null {
    if (this.#jitter === null) return null;
    return clamp(Math.round((this.#jitter * 2.5 + 0.04) * 100) / 100, MIN_DEADZONE, MAX_DEADZONE);
  }

  /** The mask currently held, for the on-screen legend. */
  get mask(): number {
    return this.#applied;
  }

  isHeld(button: ButtonName): boolean {
    return (this.#applied & bit(button)) !== 0;
  }

  /** True if this physical control is down right now — used to light up a chip. */
  isDown(token: string): boolean {
    return this.#down.has(token);
  }

  // -- the latch -----------------------------------------------------------

  /**
   * Point at the latch for the port we drive, or null to stop driving anything.
   *
   * Called once per join, because the slot we get decides the port. Clearing
   * the old latch matters: leaving it holding RIGHT would freeze a direction on
   * for the departing port in everyone else's simulation.
   */
  attach(latch: InputLatch | null): void {
    if (this.#latch === latch) return;
    this.#latch?.clear();
    this.#latch = latch;
    this.#applied = 0;
    this.#recompute();
  }

  get suspended(): boolean {
    return this.#suspended;
  }

  /** Stop driving the game without forgetting which port we drive. */
  setSuspended(suspended: boolean): void {
    if (this.#suspended === suspended) return;
    this.#suspended = suspended;
    this.#recompute();
    this.changed.emit();
  }

  // -- profile edits -------------------------------------------------------

  /**
   * Give `binding` to `button`, optionally in place of one it already has.
   *
   * A physical control drives exactly one game button, so this takes it away
   * from whoever had it. Returns that previous owner, if any, so the panel can
   * say what it just undid rather than leaving a chip to silently vanish.
   */
  bind(button: ButtonName, binding: Binding, replacing?: Binding): ButtonName | null {
    const token = tokenOf(binding);
    let stolenFrom: ButtonName | null = null;
    const next = {} as Record<ButtonName, Binding[]>;
    for (const name of BUTTON_NAMES) {
      next[name] = this.#profile.bindings[name].filter((b) => {
        if (tokenOf(b) !== token) return true;
        if (name !== button) stolenFrom = name;
        return false;
      });
    }
    const target = next[button];
    const at = replacing ? target.findIndex((b) => tokenOf(b) === tokenOf(replacing)) : -1;
    if (at >= 0) target.splice(at, 1, binding);
    else target.push(binding);
    this.#setProfile({ ...this.#profile, bindings: next });
    return stolenFrom;
  }

  unbind(button: ButtonName, binding: Binding): void {
    const token = tokenOf(binding);
    const next = { ...this.#profile.bindings, [button]: this.#profile.bindings[button].filter((b) => tokenOf(b) !== token) };
    this.#setProfile({ ...this.#profile, bindings: next });
  }

  setDeadzone(value: number): void {
    this.#setProfile({ ...this.#profile, deadzone: clamp(value, MIN_DEADZONE, MAX_DEADZONE) });
  }

  resetToDefaults(): void {
    this.#setProfile(defaultProfile());
  }

  /**
   * Learn where this pad's axes sit when nobody is touching it.
   *
   * Collects a short average rather than a single reading, because a stick that
   * rests at 0.11 also jitters around it, and a one-shot sample would bake the
   * jitter into the offset. Xbox triggers rest at -1 by design and calibrate to
   * exactly the same rule, which is why there is no trigger special case. The
   * spread of those same samples is the wobble `suggestedDeadzone` reads.
   */
  beginCentring(): boolean {
    const pad = this.#pad;
    if (!pad) return false;
    const n = pad.raw.length;
    this.#calibration = {
      phase: 'centre',
      id: pad.id,
      sum: new Array<number>(n).fill(0),
      lo: pad.raw.map((v) => v),
      hi: pad.raw.map((v) => v),
      samples: 0,
    };
    this.changed.emit();
    return true;
  }

  /**
   * Learn how far this pad's axes actually travel.
   *
   * Open-ended on purpose — it records extremes until told to stop, rather than
   * counting samples. Only the player knows when they have pushed the stick
   * into every corner, and cutting them off mid-circle would bake in a range
   * that is short on whichever side they had not reached yet.
   */
  beginSweep(): boolean {
    const pad = this.#pad;
    if (!pad) return false;
    this.#calibration = {
      phase: 'sweep',
      id: pad.id,
      lo: new Array<number>(pad.raw.length).fill(0),
      hi: new Array<number>(pad.raw.length).fill(0),
    };
    this.changed.emit();
    return true;
  }

  /**
   * Keep what the sweep saw.
   *
   * An axis that never moved keeps whatever it had rather than being recorded
   * as having no travel: a pad with one broken stick should still calibrate the
   * working one, and a divisor of zero is the one thing that must not reach the
   * profile.
   */
  commitSweep(): boolean {
    const run = this.#calibration;
    if (run?.phase !== 'sweep') return false;
    const previous = this.#profile.range[run.id] ?? [];
    const range = run.lo.map((lo, i) => {
      const hi = run.hi[i] ?? 0;
      const usable = -lo >= MIN_TRAVEL && hi >= MIN_TRAVEL;
      return usable ? ([lo, hi] as const) : (previous[i] ?? NO_TRAVEL);
    });
    this.#calibration = null;
    this.#setProfile({ ...this.#profile, range: { ...this.#profile.range, [run.id]: range } });
    return true;
  }

  cancelCalibration(): void {
    if (!this.#calibration) return;
    this.#calibration = null;
    this.changed.emit();
  }

  /** Forget everything measured for the connected pad, back to raw readings. */
  clearCalibration(): boolean {
    const pad = this.#pad;
    if (!pad) return false;
    const rest = { ...this.#profile.rest };
    const range = { ...this.#profile.range };
    delete rest[pad.id];
    delete range[pad.id];
    this.#calibration = null;
    this.#jitter = null;
    this.#setProfile({ ...this.#profile, rest, range });
    return true;
  }

  /** True once this pad has been through both phases at least once. */
  isCalibrated(): boolean {
    const pad = this.#pad;
    if (!pad) return false;
    return this.#profile.rest[pad.id] !== undefined && this.#profile.range[pad.id] !== undefined;
  }

  // -- rebinding -----------------------------------------------------------

  /**
   * Wait for one physical control and hand it back.
   *
   * Returns a cancel function; Escape cancels too, since that is what a person
   * will press when they change their mind. A capture in flight swallows the
   * keyboard entirely, so binding W does not also walk the character upward.
   */
  capture(onBound: (binding: Binding) => void): () => void {
    this.cancelCapture();
    // Snapshot the pad first: whatever is already held is not a fresh press.
    this.poll();
    this.#capture = { resolve: onBound, ignore: new Set(this.#activePadTokens()) };
    this.changed.emit();
    return () => this.cancelCapture();
  }

  cancelCapture(): void {
    if (!this.#capture) return;
    this.#capture = null;
    this.changed.emit();
  }

  // -- the gamepad ---------------------------------------------------------

  /**
   * Read the pad and fold it into the held set.
   *
   * Idempotent and cheap. Called once per emulated frame from the machine so
   * that pad sampling shares the keyboard's cadence and the audio clock, and
   * from the panel's rAF loop so the meters move before a game is running.
   *
   * A polled device cannot see a press shorter than the poll interval. At
   * ~17ms that would be a tap no human makes, and the latch's stickiness covers
   * everything above it.
   */
  poll(): void {
    const pad = this.#readPad();
    const changedDevice = (pad?.id ?? null) !== (this.#pad?.id ?? null);
    this.#pad = pad;

    if (this.#calibration) this.#stepCalibration(pad);

    // Replace every pad token in one go: unlike the keyboard there is no
    // "release" event to trust, so the poll's answer is the whole truth.
    const active = new Set(this.#activePadTokens());
    let touched = false;
    for (const token of [...this.#down]) {
      if (!token.startsWith('key:') && !active.has(token)) {
        this.#down.delete(token);
        touched = true;
      }
    }
    // While capturing, a pad control is an answer to the panel's question, not
    // a press — but anything already held still gets released above.
    if (!this.#capture) {
      for (const token of active) {
        if (this.#down.has(token)) continue;
        this.#down.add(token);
        touched = true;
      }
    }
    if (touched) this.#recompute();

    if (this.#capture) this.#stepCapture(active);
    if (changedDevice) this.changed.emit();
  }

  #readPad(): PadSnapshot | null {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    // First connected pad wins. Every peer drives one port, so a second pad on
    // the same machine has nothing to control.
    let found: Gamepad | null = null;
    for (const candidate of pads) {
      if (candidate && candidate.connected) {
        found = candidate;
        break;
      }
    }
    if (!found) return null;
    const rest = this.#profile.rest[found.id] ?? [];
    const range = this.#profile.range[found.id] ?? [];
    const raw = Array.from(found.axes);
    return {
      index: found.index,
      id: found.id,
      standard: found.mapping === 'standard',
      raw,
      corrected: raw.map((v, i) => correctAxis(v, rest[i] ?? 0, range[i] ?? NO_TRAVEL)),
      buttons: found.buttons.map((b) => b.pressed || b.value > BUTTON_THRESHOLD),
    };
  }

  #activePadTokens(): string[] {
    const pad = this.#pad;
    if (!pad) return [];
    const out: string[] = [];
    pad.buttons.forEach((pressed, i) => {
      if (pressed) out.push(`btn:${i}`);
    });
    pad.corrected.forEach((value, i) => {
      if (value <= -this.#profile.deadzone) out.push(`axis:${i}-`);
      else if (value >= this.#profile.deadzone) out.push(`axis:${i}+`);
    });
    return out;
  }

  #stepCapture(active: Set<string>): void {
    const capture = this.#capture;
    const pad = this.#pad;
    if (!capture || !pad) return;
    // Anything held since capture began stops being ignored once released.
    for (const token of capture.ignore) {
      if (!active.has(token)) capture.ignore.delete(token);
    }
    for (let i = 0; i < pad.buttons.length; i += 1) {
      const token = `btn:${i}`;
      if (pad.buttons[i] && !capture.ignore.has(token)) {
        this.#resolveCapture({ source: 'pad-button', index: i });
        return;
      }
    }
    const threshold = Math.max(CAPTURE_AXIS_THRESHOLD, this.#profile.deadzone);
    for (let i = 0; i < pad.corrected.length; i += 1) {
      const value = pad.corrected[i] ?? 0;
      if (Math.abs(value) < threshold) continue;
      const dir = value < 0 ? -1 : 1;
      if (capture.ignore.has(`axis:${i}${dir < 0 ? '-' : '+'}`)) continue;
      this.#resolveCapture({ source: 'pad-axis', index: i, dir });
      return;
    }
  }

  #resolveCapture(binding: Binding): void {
    const capture = this.#capture;
    if (!capture) return;
    this.#capture = null;
    capture.resolve(binding);
    this.changed.emit();
  }

  #stepCalibration(pad: PadSnapshot | null): void {
    const run = this.#calibration;
    if (!run) return;
    if (!pad || pad.id !== run.id) {
      // The pad went away mid-sample. Half a calibration is worse than none.
      this.#calibration = null;
      this.changed.emit();
      return;
    }
    if (run.phase === 'sweep') {
      // Relative to rest, so a sweep is measured from wherever centring put the
      // origin rather than from the device's own idea of zero.
      const rest = this.#profile.rest[run.id] ?? [];
      for (let i = 0; i < run.lo.length; i += 1) {
        const v = (pad.raw[i] ?? 0) - (rest[i] ?? 0);
        run.lo[i] = Math.min(run.lo[i] ?? 0, v);
        run.hi[i] = Math.max(run.hi[i] ?? 0, v);
      }
      return;
    }
    for (let i = 0; i < run.sum.length; i += 1) {
      const v = pad.raw[i] ?? 0;
      run.sum[i] = (run.sum[i] ?? 0) + v;
      run.lo[i] = Math.min(run.lo[i] ?? v, v);
      run.hi[i] = Math.max(run.hi[i] ?? v, v);
    }
    run.samples += 1;
    if (run.samples < CALIBRATION_SAMPLES) return;
    this.#calibration = null;
    const rest = run.sum.map((total) => clamp(total / run.samples, -1, 1));
    // Half the peak-to-peak spread of a stick nobody was touching.
    this.#jitter = Math.max(0, ...run.hi.map((hi, i) => (hi - (run.lo[i] ?? hi)) / 2));
    this.#setProfile({ ...this.#profile, rest: { ...this.#profile.rest, [run.id]: rest } });
  }

  // -- keyboard ------------------------------------------------------------

  #onKeyDown = (e: KeyboardEvent): void => {
    if (this.#capture) {
      e.preventDefault();
      if (e.repeat) return;
      if (e.code === 'Escape') this.cancelCapture();
      else this.#resolveCapture({ source: 'key', code: e.code });
      return;
    }
    if (isTyping(e.target)) return;
    const token = `key:${e.code}`;
    if (!this.#index.has(token)) return;
    e.preventDefault();
    if (e.repeat || this.#down.has(token)) return;
    this.#down.add(token);
    this.#recompute();
  };

  #onKeyUp = (e: KeyboardEvent): void => {
    const token = `key:${e.code}`;
    if (this.#capture || this.#index.has(token)) e.preventDefault();
    // A release is honoured unconditionally — mid-capture, and regardless of
    // isTyping. Both exceptions exist because the alternative is a key that was
    // down when focus or intent moved away and can now never come back up.
    if (!this.#down.delete(token)) return;
    this.#recompute();
  };

  /**
   * Focus or visibility left us.
   *
   * Both matter, and for different reasons. Losing focus means keyup will never
   * arrive. Losing visibility means the browser stops refreshing the gamepad
   * for an unfocused document, so the last poll's values would otherwise stand
   * forever — and in lockstep a stuck direction is not merely this player's
   * problem, it is published to everyone.
   */
  #onLeave = (): void => {
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    if (this.#down.size === 0) return;
    this.#down.clear();
    this.#recompute();
  };

  #onPadChange = (): void => {
    this.poll();
    this.changed.emit();
  };

  // -- plumbing ------------------------------------------------------------

  #setProfile(profile: ControlProfile): void {
    this.#profile = profile;
    this.#reindex();
    saveProfile(profile);
    /*
     * Rest, travel and deadzone all change what an axis reads, and the snapshot
     * was computed from the profile this one just replaced. Re-reading here
     * rather than waiting for the next poll keeps "corrected agrees with the
     * profile that produced it" true at every instant — otherwise the frame in
     * which centring commits still reports the drift it just cancelled.
     */
    if (this.#pad) this.#pad = this.#readPad();
    this.#recompute();
    this.changed.emit();
  }

  #reindex(): void {
    this.#index = new Map();
    for (const name of BUTTON_NAMES) {
      for (const binding of this.#profile.bindings[name]) {
        const token = tokenOf(binding);
        this.#index.set(token, (this.#index.get(token) ?? 0) | bit(name));
      }
    }
    // A control that was down when it stopped being bound would otherwise be
    // held forever, since its release no longer resolves to anything.
    for (const token of [...this.#down]) {
      if (!this.#index.has(token)) this.#down.delete(token);
    }
  }

  #recompute(): void {
    let mask = 0;
    // Still tracked while suspended — `isDown` keeps lighting the picture up,
    // it just stops reaching the emulator.
    if (!this.#suspended) {
      for (const token of this.#down) mask |= this.#index.get(token) ?? 0;
    }
    this.#apply(mask);
  }

  /**
   * Push the difference into the latch.
   *
   * Diffing rather than re-pressing matters because the latch is sticky:
   * press() also arms the sticky bit, so re-pressing a held button every poll
   * would be harmless but pointless, while releasing one source of a button
   * that another source still holds must not release the button.
   */
  #apply(next: number): void {
    const prev = this.#applied;
    if (next === prev) return;
    this.#applied = next;
    const latch = this.#latch;
    if (!latch) return;
    const pressed = next & ~prev;
    const released = prev & ~next;
    if (pressed) latch.press(pressed);
    if (released) latch.release(released);
  }
}
