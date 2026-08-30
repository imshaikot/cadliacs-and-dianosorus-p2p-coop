/**
 * The controller dialog: your pad, drawn, reacting, and walked through
 * calibration one step at a time.
 *
 * Modelled on what a console does, because a console has already solved this
 * for people who do not want to learn what an axis is. You see the controller.
 * You press something and it lights up. When something needs doing, it asks for
 * one thing at a time and waits.
 *
 * Two jobs, and the first is the one that earns its place: **it is a tester**.
 * "Is my stick drifting?" and "is this button even reaching the browser?" are
 * the questions people actually arrive with, and both are answered by opening
 * this and looking. Calibration is what you do once the picture has shown you
 * something is wrong.
 *
 * Input is suspended for as long as this is open — see `setSuspended`. Being
 * asked to sweep both sticks fully while the game is live would send the
 * character across the screen, and under lockstep that is everyone's problem.
 */
import { MAX_DEADZONE, MIN_DEADZONE, tokenOf } from './emulator/bindings.js';
import type { LocalControls } from './emulator/controls.js';
import { BUTTON_NAMES } from './emulator/input.js';
import { ControllerCanvas } from './controller-canvas.js';

function must<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as unknown as T;
}

/**
 * Where the wizard is.
 *
 * `idle` is not a step in the wizard — it is the dialog doing its other job,
 * showing you a live pad with nothing being asked of you.
 */
type Step = 'idle' | 'centre' | 'sweep' | 'deadzone';

const COPY: Readonly<Record<Step, { title: string; body: string; primary: string }>> = {
  idle: {
    title: 'Press anything',
    body: 'Buttons light up as you press them; the dots show where your sticks are. The dashed ring is the deadzone — a stick resting outside it is drifting, and calibrating will fix that.',
    primary: 'calibrate',
  },
  centre: {
    title: 'Let go of everything',
    body: 'Hands off the pad. Measuring where the sticks sit when nothing is touching them.',
    primary: 'skip',
  },
  sweep: {
    title: 'Roll both sticks around, twice',
    body: 'All the way to the edge, right the way round — both sticks, and the triggers too if it has them. This measures how far yours actually travel.',
    primary: 'done sweeping',
  },
  deadzone: {
    title: 'Hands off once more',
    body: 'How far a stick must move before the game hears it. Lower is more responsive; too low and a resting stick walks on its own.',
    primary: 'finish',
  },
};

export class ControllerDialog {
  readonly #controls: LocalControls;
  readonly #dialog = must<HTMLDialogElement>('pad-modal');
  readonly #canvasEl = must<HTMLCanvasElement>('pad-canvas');
  readonly #name = must<HTMLElement>('pad-name');
  readonly #steps = must<HTMLOListElement>('pad-steps');
  readonly #title = must<HTMLElement>('pad-step-title');
  readonly #body = must<HTMLElement>('pad-step-body');
  readonly #progress = must<HTMLElement>('pad-progress');
  readonly #primary = must<HTMLButtonElement>('btn-pad-primary');
  readonly #secondary = must<HTMLButtonElement>('btn-pad-secondary');
  readonly #deadzoneRow = must<HTMLElement>('pad-deadzone-row');
  readonly #deadzone = must<HTMLInputElement>('pad-deadzone');
  readonly #deadzoneOut = must<HTMLOutputElement>('pad-deadzone-out');
  readonly #suggest = must<HTMLButtonElement>('btn-pad-suggest');
  readonly #readout = must<HTMLElement>('pad-readout');

  readonly #canvas: ControllerCanvas;
  #step: Step = 'idle';
  #raf = 0;
  /** Rebuilt on profile change, so the picture can label what each control does. */
  #labels = new Map<string, string>();

  constructor(controls: LocalControls) {
    this.#controls = controls;
    this.#canvas = new ControllerCanvas(this.#canvasEl);

    this.#deadzone.min = String(MIN_DEADZONE);
    this.#deadzone.max = String(MAX_DEADZONE);
    this.#deadzone.addEventListener('input', () => {
      this.#controls.setDeadzone(Number(this.#deadzone.value));
      this.#syncDeadzone();
    });
    this.#suggest.addEventListener('click', () => {
      const suggested = this.#controls.suggestedDeadzone;
      if (suggested === null) return;
      this.#controls.setDeadzone(suggested);
      this.#syncDeadzone();
    });

    this.#primary.addEventListener('click', () => this.#advance());
    this.#secondary.addEventListener('click', () => this.#onSecondary());
    // Escape closes a <dialog> on its own; this is the same exit, so the
    // suspension and the rAF loop are unwound in exactly one place.
    this.#dialog.addEventListener('close', () => this.#onClosed());

    controls.changed.on(() => {
      this.#rebuildLabels();
      if (this.#dialog.open) this.#render();
    });
    this.#rebuildLabels();
  }

  get isOpen(): boolean {
    return this.#dialog.open;
  }

  open(): void {
    if (this.#dialog.open) return;
    this.#step = 'idle';
    // Suspend before showing, so a button still held from the click that opened
    // this cannot get through in the gap.
    this.#controls.setSuspended(true);
    this.#canvas.refreshPalette();
    this.#dialog.showModal();
    this.#render();
    this.#raf = requestAnimationFrame(this.#tick);
  }

  close(): void {
    if (this.#dialog.open) this.#dialog.close();
  }

  destroy(): void {
    this.close();
    this.#onClosed();
  }

  #onClosed(): void {
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    // Whatever the wizard was midway through is abandoned rather than half
    // applied: a rest offset from a pass nobody finished is worse than none.
    this.#controls.cancelCalibration();
    this.#step = 'idle';
    this.#controls.setSuspended(false);
  }

  // -- the wizard ------------------------------------------------------------

  #advance(): void {
    switch (this.#step) {
      case 'idle': {
        // Centring needs a pad to sample. Saying so beats a button that looks
        // broken because the browser has not revealed the device yet.
        if (!this.#controls.beginCentring()) return;
        this.#step = 'centre';
        break;
      }
      case 'centre': {
        // "skip" — the player would rather not wait out the sample.
        this.#controls.cancelCalibration();
        this.#step = 'sweep';
        this.#controls.beginSweep();
        break;
      }
      case 'sweep': {
        this.#controls.commitSweep();
        this.#step = 'deadzone';
        break;
      }
      case 'deadzone': {
        this.#step = 'idle';
        break;
      }
    }
    this.#render();
  }

  #onSecondary(): void {
    if (this.#step === 'idle') {
      this.#controls.clearCalibration();
      return;
    }
    this.#controls.cancelCalibration();
    this.#step = 'idle';
    this.#render();
  }

  /** Centring ends on its own, so the wizard has to notice rather than be told. */
  #maybeAutoAdvance(): void {
    if (this.#step !== 'centre') return;
    if (this.#controls.calibration !== null) return;
    this.#step = 'sweep';
    this.#controls.beginSweep();
    this.#render();
  }

  // -- drawing ---------------------------------------------------------------

  #tick = (): void => {
    this.#raf = requestAnimationFrame(this.#tick);
    // The controls panel polls too, and both are the same idempotent read — but
    // this must not depend on that panel existing or being open.
    this.#controls.poll();
    this.#maybeAutoAdvance();

    this.#canvas.draw({
      pad: this.#controls.pad,
      deadzone: this.#controls.profile.deadzone,
      labelFor: (token) => this.#labels.get(token) ?? null,
      askingForSticks: this.#step === 'sweep',
    });
    this.#renderLive();
  };

  /** Everything that changes per frame. The rest is redrawn only on a change. */
  #renderLive(): void {
    const run = this.#controls.calibration;
    if (this.#step === 'centre') {
      const pct = Math.round((run?.progress ?? 1) * 100);
      this.#progress.style.setProperty('--fraction', `${pct}%`);
      this.#progress.textContent = `sampling ${pct}%`;
      return;
    }
    if (this.#step === 'sweep' && run?.phase === 'sweep') {
      const done = run.travel.filter(([lo, hi]) => -lo >= 0.35 && hi >= 0.35).length;
      this.#progress.style.setProperty('--fraction', `${Math.round(run.progress * 100)}%`);
      this.#progress.textContent = `${done} of ${run.travel.length} axes swept`;
      this.#readout.textContent = run.travel
        .map(([lo, hi], i) => `AX${i} ${lo.toFixed(2)}…${hi.toFixed(2)}`)
        .join('   ');
      return;
    }
    if (this.#step === 'idle') {
      const pad = this.#controls.pad;
      this.#readout.textContent = pad
        ? `${pad.buttons.length} buttons · ${pad.raw.length} axes · ${pad.standard ? 'standard mapping' : 'unrecognised mapping'}`
        : '';
    }
  }

  /** Structure, copy and which controls are relevant to the step we are on. */
  #render(): void {
    const pad = this.#controls.pad;
    const copy = COPY[this.#step];
    // On the element rather than only in a field: it gives CSS something to
    // hang off, and it is the one honest answer to "which step is this".
    this.#dialog.dataset['step'] = this.#step;

    this.#name.textContent = pad ? shortPadName(pad.id) : 'no gamepad';
    this.#name.dataset['state'] = pad ? (pad.standard ? 'standard' : 'unmapped') : 'none';
    this.#name.title = pad?.id ?? 'The browser only reveals a gamepad after you press a button on it.';

    this.#title.textContent = copy.title;
    this.#body.textContent = copy.body;
    this.#primary.textContent = copy.primary;
    // Nothing to calibrate without a device, and a wizard that starts anyway
    // would just fail at its first step.
    this.#primary.disabled = pad === null && this.#step === 'idle';
    this.#secondary.textContent = this.#step === 'idle' ? 'clear calibration' : 'cancel';
    this.#secondary.disabled = this.#step === 'idle' && !this.#controls.isCalibrated();

    this.#progress.hidden = this.#step !== 'centre' && this.#step !== 'sweep';
    this.#deadzoneRow.hidden = this.#step === 'centre' || this.#step === 'sweep';
    this.#readout.hidden = this.#step === 'deadzone';

    for (const [i, li] of [...this.#steps.children].entries()) {
      if (!(li instanceof HTMLElement)) continue;
      const order: Step[] = ['centre', 'sweep', 'deadzone'];
      const at = order.indexOf(this.#step);
      li.dataset['state'] = at < 0 ? 'idle' : i < at ? 'done' : i === at ? 'now' : 'todo';
    }

    this.#syncDeadzone();
  }

  #syncDeadzone(): void {
    const dz = this.#controls.profile.deadzone;
    this.#deadzone.value = String(dz);
    this.#deadzoneOut.textContent = dz.toFixed(2);
    const suggested = this.#controls.suggestedDeadzone;
    const jitter = this.#controls.restJitter;
    if (suggested === null || jitter === null) {
      this.#suggest.hidden = true;
      return;
    }
    this.#suggest.hidden = false;
    this.#suggest.textContent = `use ${suggested.toFixed(2)}`;
    this.#suggest.title = `Your sticks wandered ±${jitter.toFixed(3)} at rest.`;
  }

  /**
   * Which game button each physical control drives, so the picture is also the
   * mapping. Keyboard bindings are skipped — there is no key on this drawing.
   */
  #rebuildLabels(): void {
    this.#labels = new Map();
    for (const name of BUTTON_NAMES) {
      for (const binding of this.#controls.profile.bindings[name]) {
        if (binding.source === 'key') continue;
        const token = tokenOf(binding);
        const existing = this.#labels.get(token);
        // One control can legitimately drive two things if someone bound it
        // twice; showing both beats silently picking one.
        this.#labels.set(token, existing ? `${existing}/${name}` : name);
      }
    }
  }
}

/** Pad ids are long and vendor-shaped. The panel trims them the same way. */
function shortPadName(id: string): string {
  const trimmed = id.replace(/\s*\((?:STANDARD GAMEPAD\s*)?Vendor:[^)]*\)\s*$/i, '').trim();
  const name = trimmed || id;
  return name.length > 30 ? `${name.slice(0, 29)}…` : name;
}
