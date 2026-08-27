/**
 * Input model.
 *
 * libretro joypad button ids. The player is game-agnostic, so the buttons are
 * named by their position on the cabinet's six-button cluster rather than by
 * what any one game does with them: B1..B3 is the top row, B4..B6 the bottom.
 * A beat-'em-up uses two of them; a fighter uses all six.
 *
 * The ids are the ones FBNeo publishes in SET_INPUT_DESCRIPTORS on its first
 * frame, and every port carries the identical set.
 */
export const BUTTON = {
  B4: 0, //  RETRO_DEVICE_ID_JOYPAD_B
  B1: 1, //  Y
  COIN: 2, // SELECT
  START: 3, // START
  UP: 4,
  DOWN: 5,
  LEFT: 6,
  RIGHT: 7,
  B5: 8, //  A
  B2: 9, //  X
  B3: 10, // L
  B6: 11, // R
} as const;

export type ButtonName = keyof typeof BUTTON;
export const BUTTON_NAMES = Object.keys(BUTTON) as ButtonName[];

export function bit(button: ButtonName): number {
  return 1 << BUTTON[button];
}

/**
 * Arcade conventions: 5 inserts a coin, 1 starts.
 *
 * The six buttons sit on U/I/O over J/K/L, which is the cluster's own 3x2 shape
 * and clear of the WASD the left hand is steering with. Z and X stay bound to
 * the bottom row as well, because on a two-button game they are where hands
 * already go.
 */
export const DEFAULT_KEYMAP: Readonly<Record<string, ButtonName>> = {
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  ArrowLeft: 'LEFT',
  ArrowRight: 'RIGHT',
  KeyW: 'UP',
  KeyS: 'DOWN',
  KeyA: 'LEFT',
  KeyD: 'RIGHT',
  KeyU: 'B1',
  KeyI: 'B2',
  KeyO: 'B3',
  KeyJ: 'B4',
  KeyK: 'B5',
  KeyL: 'B6',
  KeyZ: 'B4',
  KeyX: 'B5',
  KeyC: 'B6',
  Digit5: 'COIN',
  Digit1: 'START',
};

/**
 * A one-port input latch.
 *
 * Gotcha #9: the emulator must see a stable mask for the whole of a frame, and
 * that mask must be sampled exactly once per frame. Applying key events as they
 * arrive drops and duplicates presses.
 *
 * `sticky` is the other half of the same problem. Key events are asynchronous;
 * a fast tap can go down and up between two latches and would otherwise vanish
 * entirely. Anything pressed at any point since the last latch counts as
 * pressed for that frame, so a press can be late but never lost.
 */
export class InputLatch {
  #held = 0;
  #sticky = 0;

  press(mask: number): void {
    this.#held |= mask;
    this.#sticky |= mask;
  }

  release(mask: number): void {
    this.#held &= ~mask;
  }

  /** Whatever is currently held, plus anything tapped since the last call. */
  latch(): number {
    const mask = this.#held | this.#sticky;
    this.#sticky = 0;
    return mask;
  }

  /** Losing focus must not leave a direction stuck on. */
  clear(): void {
    this.#held = 0;
    this.#sticky = 0;
  }

  get held(): number {
    return this.#held;
  }
}

/**
 * The keymap claims W/A/S/D/Z/X/1/5, which are also just letters. Without this
 * the chat box would be unusable the moment the emulator is running.
 *
 * Exported because every other page-level hotkey owes the chat box the same
 * courtesy -- see the fullscreen binding in `ui.ts`.
 */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function describeMask(mask: number): string {
  const on = BUTTON_NAMES.filter((n) => mask & bit(n));
  return on.length ? on.join('+') : '—';
}
