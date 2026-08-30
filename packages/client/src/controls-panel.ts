/**
 * The controls panel: what your buttons do, lit up as you press them, and
 * clickable to change.
 *
 * Two jobs in one place on purpose. A legend nobody can edit goes stale the
 * moment someone plugs a stick in, and a remapper with no live feedback cannot
 * tell you whether the thing you just bound is the thing that is now drifting.
 * Chips light while their physical control is down, so "why is my character
 * walking left" has an answer on the same screen as the fix.
 *
 * It drives its own rAF loop rather than borrowing the emulator's, because it
 * has to work on the landing page — before a room, a ROM or a clock exists.
 *
 * Anything to do with the *device* rather than the mapping — how far the sticks
 * travel, where they rest, the deadzone — lives in the controller dialog next
 * door. This list is about what your controls do; that is about what they are.
 */
import { BUTTON_GLYPH, describeBinding, tokenOf } from './emulator/bindings.js';
import type { Binding } from './emulator/bindings.js';
import type { LocalControls } from './emulator/controls.js';
import { BUTTON_NAMES } from './emulator/input.js';
import type { ButtonName } from './emulator/input.js';

function must<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as unknown as T;
}

/**
 * Reading order for the legend: stick, then the six-button cluster in its own
 * physical order, then the cabinet's coin and start. BUTTON_NAMES is in libretro
 * id order, which scatters the cluster and puts COIN above UP — right for a wire
 * protocol, wrong for something a person reads.
 */
const DISPLAY_ORDER: readonly ButtonName[] = [
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
  'B1',
  'B2',
  'B3',
  'B4',
  'B5',
  'B6',
  'COIN',
  'START',
];

/** Anything added to BUTTON later still shows up, just at the end, rather than
 *  silently vanishing from the legend. */
const ORDERED: readonly ButtonName[] = [
  ...DISPLAY_ORDER,
  ...BUTTON_NAMES.filter((name) => !DISPLAY_ORDER.includes(name)),
];

/** A rebind that never receives a press should not wait forever. */
const CAPTURE_TIMEOUT_MS = 6000;

const IDLE_HINT = 'Click a binding to change it, × to remove it, + to add one. Esc cancels.';

export class ControlsPanel {
  readonly #controls: LocalControls;
  readonly #list = must<HTMLOListElement>('control-list');
  readonly #who = must<HTMLElement>('controls-who');
  readonly #padPill = must<HTMLElement>('pad-pill');
  readonly #hint = must<HTMLElement>('controls-hint');
  readonly #reset = must<HTMLButtonElement>('btn-controls-reset');
  readonly #openPad = must<HTMLButtonElement>('btn-pad-open');

  /** Which button is waiting for a press, and the chip that will hold it. */
  #capturing: { button: ButtonName; replacing: Binding | null } | null = null;
  #captureTimer: number | null = null;
  #raf = 0;
  /** Opens the controller dialog. Installed by main, which owns that dialog. */
  #onOpenPad: (() => void) | null = null;

  constructor(controls: LocalControls) {
    this.#controls = controls;

    this.#list.addEventListener('click', (e) => this.#onListClick(e));
    this.#openPad.addEventListener('click', () => {
      this.#openPad.blur();
      this.#onOpenPad?.();
    });
    this.#reset.addEventListener('click', () => {
      this.#controls.cancelCapture();
      this.#controls.resetToDefaults();
      this.#say('Defaults restored.');
      this.#reset.blur();
    });
    controls.changed.on(() => this.render());
    this.render();
    this.#say(IDLE_HINT);
    this.#raf = requestAnimationFrame(this.#tick);
  }

  destroy(): void {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    if (this.#captureTimer !== null) clearTimeout(this.#captureTimer);
  }

  /** What `controller…` does. Set by main, which owns the dialog. */
  onOpenController(open: () => void): void {
    this.#onOpenPad = open;
  }

  /** Which player this peer drives, or null when it is not in a room. */
  setSlot(slot: number | null): void {
    if (slot === null) {
      delete this.#who.dataset['slot'];
      this.#who.textContent = 'not in a room';
      return;
    }
    this.#who.dataset['slot'] = String(slot);
    this.#who.textContent = `you are P${slot}`;
  }

  // -- drawing -------------------------------------------------------------

  /** Full rebuild. Cheap — eight rows — and only on an actual change. */
  render(): void {
    if (!this.#controls.capturing) this.#clearCapture();
    const pad = this.#controls.pad;
    const standard = pad?.standard ?? false;

    this.#list.replaceChildren(
      ...ORDERED.map((name) => this.#row(name, standard)),
    );

    this.#padPill.textContent = pad ? shortPadName(pad.id) : 'no gamepad';
    this.#padPill.dataset['state'] = pad ? (standard ? 'standard' : 'unmapped') : 'none';
    this.#padPill.title = pad
      ? `${pad.id}\n${pad.buttons.length} buttons, ${pad.raw.length} axes, mapping: ${standard ? 'standard' : 'unknown'}`
      : 'The browser only reveals a gamepad after you press a button on it.';
  }

  #row(name: ButtonName, standard: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.dataset['button'] = name;
    const capturing = this.#capturing?.button === name;
    if (capturing) li.dataset['capturing'] = 'true';

    const label = document.createElement('span');
    label.className = 'ctl-label';
    const glyph = document.createElement('span');
    glyph.className = 'ctl-glyph';
    glyph.textContent = BUTTON_GLYPH[name];
    const text = document.createElement('span');
    text.className = 'ctl-name';
    text.textContent = name;
    label.append(glyph, text);

    const binds = document.createElement('span');
    binds.className = 'ctl-binds';
    const bindings = this.#controls.profile.bindings[name];
    for (const binding of bindings) {
      binds.append(this.#chip(binding, standard, capturing && sameBinding(this.#capturing?.replacing, binding)));
    }
    if (bindings.length === 0) {
      const none = document.createElement('span');
      none.className = 'ctl-none';
      none.textContent = 'unbound';
      binds.append(none);
    }

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'bind add';
    add.textContent = capturing && this.#capturing?.replacing === null ? 'press…' : '+';
    add.title = `Add another control for ${name}`;
    binds.append(add);

    li.append(label, binds);
    return li;
  }

  #chip(binding: Binding, standard: boolean, listening: boolean): HTMLButtonElement {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'bind';
    chip.dataset['token'] = tokenOf(binding);
    chip.dataset['source'] = binding.source;
    chip.title = `Click to rebind, × to remove (${tokenOf(binding)})`;
    const label = document.createElement('span');
    label.className = 'bind-label';
    label.textContent = listening ? 'press…' : describeBinding(binding, standard);
    const remove = document.createElement('span');
    remove.className = 'x';
    remove.textContent = '×';
    chip.append(label, remove);
    return chip;
  }

  // -- the live loop -------------------------------------------------------

  #tick = (): void => {
    this.#raf = requestAnimationFrame(this.#tick);
    // Also the only thing polling the pad before a ROM is loaded; once the
    // emulator is running it polls too, and the two are the same idempotent read.
    this.#controls.poll();

    for (const li of this.#list.children) {
      if (!(li instanceof HTMLElement)) continue;
      const name = li.dataset['button'] as ButtonName | undefined;
      if (!name) continue;
      setFlag(li, 'held', this.#controls.isHeld(name));
      for (const chip of li.querySelectorAll<HTMLElement>('.bind[data-token]')) {
        const token = chip.dataset['token'];
        setFlag(chip, 'down', token !== undefined && this.#controls.isDown(token));
      }
    }

  };

  // -- rebinding -----------------------------------------------------------

  #onListClick(e: MouseEvent): void {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const chip = target.closest<HTMLElement>('.bind');
    const li = target.closest<HTMLElement>('li[data-button]');
    if (!chip || !li) return;
    const name = li.dataset['button'] as ButtonName | undefined;
    if (!name) return;

    const token = chip.dataset['token'];
    const binding = token ? this.#controls.profile.bindings[name].find((b) => tokenOf(b) === token) : undefined;

    if (binding && target.closest('.x')) {
      this.#controls.cancelCapture();
      this.#controls.unbind(name, binding);
      this.#say(`${describeBinding(binding, this.#controls.pad?.standard ?? false)} is no longer ${name}.`);
      return;
    }
    this.#beginCapture(name, binding ?? null);
  }

  #beginCapture(button: ButtonName, replacing: Binding | null): void {
    this.#clearCapture();
    this.#capturing = { button, replacing };
    this.#controls.capture((binding) => this.#onCaptured(button, binding, replacing));
    this.#captureTimer = window.setTimeout(() => {
      this.#controls.cancelCapture();
      this.#say('Nothing pressed — nothing changed.');
    }, CAPTURE_TIMEOUT_MS);
    this.render();
    this.#say(`Press a key, or a gamepad button or stick direction, for ${button}. Esc cancels.`);
  }

  #onCaptured(button: ButtonName, binding: Binding, replacing: Binding | null): void {
    this.#clearCapture();
    const standard = this.#controls.pad?.standard ?? false;
    const stolenFrom = this.#controls.bind(button, binding, replacing ?? undefined);
    const label = describeBinding(binding, standard);
    this.#say(
      stolenFrom
        ? `${label} is now ${button} — it used to be ${stolenFrom}, which lost it.`
        : `${label} is now ${button}.`,
    );
  }

  #clearCapture(): void {
    this.#capturing = null;
    if (this.#captureTimer !== null) clearTimeout(this.#captureTimer);
    this.#captureTimer = null;
  }

  #say(message: string): void {
    this.#hint.textContent = message;
  }
}

function sameBinding(a: Binding | null | undefined, b: Binding): boolean {
  return a != null && tokenOf(a) === tokenOf(b);
}

function setFlag(el: HTMLElement, name: string, on: boolean): void {
  if (on) {
    if (el.dataset[name] !== 'true') el.dataset[name] = 'true';
  } else if (el.dataset[name] !== undefined) {
    delete el.dataset[name];
  }
}

/** Pad ids are long and vendor-shaped: "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e...)". */
function shortPadName(id: string): string {
  const trimmed = id.replace(/\s*\((?:STANDARD GAMEPAD\s*)?Vendor:[^)]*\)\s*$/i, '').trim();
  const name = trimmed || id;
  return name.length > 34 ? `${name.slice(0, 33)}…` : name;
}
