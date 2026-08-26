/**
 * Input model.
 *
 * libretro joypad button ids, as FBNeo maps them for `dino` (confirmed from the
 * SET_INPUT_DESCRIPTORS table the core publishes on its first frame — all three
 * ports carry the identical eight controls):
 */
export const BUTTON = {
  ATTACK: 0, // RETRO_DEVICE_ID_JOYPAD_B
  COIN: 2, //   SELECT
  START: 3, //  START
  UP: 4,
  DOWN: 5,
  LEFT: 6,
  RIGHT: 7,
  JUMP: 8, //   A
} as const;

export type ButtonName = keyof typeof BUTTON;
export const BUTTON_NAMES = Object.keys(BUTTON) as ButtonName[];

export function bit(button: ButtonName): number {
  return 1 << BUTTON[button];
}

/** Arcade conventions: 5 inserts a coin, 1 starts. */
export const DEFAULT_KEYMAP: Readonly<Record<string, ButtonName>> = {
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  ArrowLeft: 'LEFT',
  ArrowRight: 'RIGHT',
  KeyW: 'UP',
  KeyS: 'DOWN',
  KeyA: 'LEFT',
  KeyD: 'RIGHT',
  KeyZ: 'ATTACK',
  KeyX: 'JUMP',
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

/** Binds a keymap to a latch. Returns a teardown function. */
export function bindKeyboard(
  latch: InputLatch,
  target: Window | HTMLElement = window,
  keymap: Readonly<Record<string, ButtonName>> = DEFAULT_KEYMAP,
): () => void {
  const onDown = (e: Event): void => {
    if (isTyping(e.target)) return;
    const key = (e as KeyboardEvent).code;
    const button = keymap[key];
    if (!button) return;
    e.preventDefault();
    if ((e as KeyboardEvent).repeat) return;
    latch.press(bit(button));
  };
  const onUp = (e: Event): void => {
    if (isTyping(e.target)) return;
    const button = keymap[(e as KeyboardEvent).code];
    if (!button) return;
    e.preventDefault();
    latch.release(bit(button));
  };
  const onBlur = (): void => latch.clear();

  target.addEventListener('keydown', onDown);
  target.addEventListener('keyup', onUp);
  window.addEventListener('blur', onBlur);
  return () => {
    target.removeEventListener('keydown', onDown);
    target.removeEventListener('keyup', onUp);
    window.removeEventListener('blur', onBlur);
  };
}

/**
 * The keymap claims W/A/S/D/Z/X/1/5, which are also just letters. Without this
 * the chat box would be unusable the moment the emulator is running.
 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function describeMask(mask: number): string {
  const on = BUTTON_NAMES.filter((n) => mask & bit(n));
  return on.length ? on.join('+') : '—';
}
