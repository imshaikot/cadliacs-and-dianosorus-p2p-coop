/**
 * What a physical control *is*, independent of what it does.
 *
 * A binding is one source: a keyboard key, a gamepad button, or one direction
 * of one gamepad axis. Every game button holds a list of them, so B4 can be Z
 * *and* J *and* the pad's A button at the same time without any of them knowing
 * about the others — which is what lets someone plug a stick in mid-session and
 * keep the keyboard as a fallback.
 *
 * Axis bindings carry a direction rather than a threshold. The threshold is the
 * profile's deadzone, shared by every axis, because a stick that needs a
 * different deadzone per direction needs calibrating, not re-binding.
 */
import { BUTTON_NAMES, DEFAULT_KEYMAP } from './input.js';
import type { ButtonName } from './input.js';

export type Binding =
  | { readonly source: 'key'; readonly code: string }
  | { readonly source: 'pad-button'; readonly index: number }
  | { readonly source: 'pad-axis'; readonly index: number; readonly dir: -1 | 1 };

export type Bindings = Readonly<Record<ButtonName, readonly Binding[]>>;

export interface ControlProfile {
  readonly bindings: Bindings;
  /**
   * How far an axis must leave its *calibrated* rest position to read as
   * pressed. Cheap sticks wander a long way; 0.35 is generous on purpose,
   * because a false RIGHT in lockstep is a false RIGHT on everyone's screen.
   */
  readonly deadzone: number;
  /**
   * Measured rest position per axis, keyed by gamepad id.
   *
   * Half the calibration. A worn stick rests at 0.12 rather than 0, and an
   * Xbox trigger rests at -1 by design; subtracting the measured rest turns
   * both into "0 means untouched" without any per-device special-casing.
   */
  readonly rest: Readonly<Record<string, readonly number[]>>;
  /**
   * Measured travel per axis as `[lo, hi]` either side of rest, keyed by
   * gamepad id. The other half.
   *
   * Rest alone assumes every stick reaches ±1, and a tired one does not: at
   * 0.72 of travel the deadzone eats a third of what is left and the last
   * third of the gate never arrives at all. Dividing by what the stick
   * actually reaches restores a full-scale ±1 from whatever it has left.
   *
   * Two numbers rather than one because travel is routinely asymmetric — the
   * same stick giving −1.00 and +0.78 is ordinary — and a single span would
   * split the difference and be wrong in both directions.
   */
  readonly range: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>>;
}

export const MIN_DEADZONE = 0.05;
export const MAX_DEADZONE = 0.8;

/**
 * Standard-mapping labels. The Gamepad API only promises these when
 * `mapping === 'standard'`; anything else gets the bare index, which is honest
 * rather than confidently wrong.
 */
const STANDARD_BUTTONS = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'BACK', 'START',
  'L3', 'R3', 'D-UP', 'D-DOWN', 'D-LEFT', 'D-RIGHT', 'HOME',
];
const STANDARD_AXES = ['L-X', 'L-Y', 'R-X', 'R-Y'];

/** Arrow glyphs for the four directions, for the on-screen legend. */
export const BUTTON_GLYPH: Readonly<Record<ButtonName, string>> = {
  UP: '↑',
  DOWN: '↓',
  LEFT: '←',
  RIGHT: '→',
  B1: '①',
  B2: '②',
  B3: '③',
  B4: '④',
  B5: '⑤',
  B6: '⑥',
  COIN: '◎',
  START: '▶',
};

/**
 * Defaults.
 *
 * The keyboard half is derived from DEFAULT_KEYMAP rather than restated, so the
 * arcade conventions (5 coins, 1 starts) have exactly one home. The pad half is
 * the standard mapping's d-pad and left stick, plus the six-button cluster laid
 * onto the pad the way every fighting game does it: face buttons for the bottom
 * row a thumb reaches first, shoulders for the top.
 */
function defaultBindings(): Bindings {
  const out = {} as Record<ButtonName, Binding[]>;
  for (const name of BUTTON_NAMES) out[name] = [];
  for (const [code, name] of Object.entries(DEFAULT_KEYMAP)) {
    out[name].push({ source: 'key', code });
  }
  const pad: Record<ButtonName, Binding[]> = {
    UP: [{ source: 'pad-button', index: 12 }, { source: 'pad-axis', index: 1, dir: -1 }],
    DOWN: [{ source: 'pad-button', index: 13 }, { source: 'pad-axis', index: 1, dir: 1 }],
    LEFT: [{ source: 'pad-button', index: 14 }, { source: 'pad-axis', index: 0, dir: -1 }],
    RIGHT: [{ source: 'pad-button', index: 15 }, { source: 'pad-axis', index: 0, dir: 1 }],
    B1: [{ source: 'pad-button', index: 2 }],
    B2: [{ source: 'pad-button', index: 3 }],
    B3: [{ source: 'pad-button', index: 5 }],
    B4: [{ source: 'pad-button', index: 0 }],
    B5: [{ source: 'pad-button', index: 1 }],
    B6: [{ source: 'pad-button', index: 4 }],
    COIN: [{ source: 'pad-button', index: 8 }],
    START: [{ source: 'pad-button', index: 9 }],
  };
  for (const name of BUTTON_NAMES) out[name].push(...pad[name]);
  return out;
}

export function defaultProfile(): ControlProfile {
  return { bindings: defaultBindings(), deadzone: 0.35, rest: {}, range: {} };
}

/**
 * A binding's identity, and its storage form.
 *
 * One string per physical control means "is this thing currently down" is a Set
 * membership test rather than a scan of eight arrays, and it means the profile
 * serialises to something a human can read in devtools.
 */
export function tokenOf(binding: Binding): string {
  switch (binding.source) {
    case 'key':
      return `key:${binding.code}`;
    case 'pad-button':
      return `btn:${binding.index}`;
    case 'pad-axis':
      return `axis:${binding.index}${binding.dir < 0 ? '-' : '+'}`;
  }
}

export function parseToken(token: string): Binding | null {
  if (token.startsWith('key:')) {
    const code = token.slice(4);
    return code ? { source: 'key', code } : null;
  }
  if (token.startsWith('btn:')) {
    const index = Number(token.slice(4));
    return Number.isInteger(index) && index >= 0 && index < 64 ? { source: 'pad-button', index } : null;
  }
  if (token.startsWith('axis:')) {
    const body = token.slice(5);
    const sign = body.slice(-1);
    const index = Number(body.slice(0, -1));
    if (!Number.isInteger(index) || index < 0 || index >= 32) return null;
    if (sign !== '+' && sign !== '-') return null;
    return { source: 'pad-axis', index, dir: sign === '-' ? -1 : 1 };
  }
  return null;
}

/** Human label for a chip in the controls panel. */
export function describeBinding(binding: Binding, standardMapping = false): string {
  switch (binding.source) {
    case 'key':
      return describeKey(binding.code);
    case 'pad-button': {
      const name = standardMapping ? STANDARD_BUTTONS[binding.index] : undefined;
      return name ?? `PAD ${binding.index}`;
    }
    case 'pad-axis': {
      const name = standardMapping ? STANDARD_AXES[binding.index] : undefined;
      return `${name ?? `AXIS ${binding.index}`} ${binding.dir < 0 ? '−' : '+'}`;
    }
  }
}

/** `KeyboardEvent.code` is a hardware position, not a legend. Make it look like one. */
function describeKey(code: string): string {
  const arrows: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
  };
  if (arrows[code]) return arrows[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6)}`;
  const named: Record<string, string> = {
    Space: 'SPACE',
    Enter: 'ENTER',
    Escape: 'ESC',
    Tab: 'TAB',
    Backspace: 'BKSP',
    ShiftLeft: 'L SHIFT',
    ShiftRight: 'R SHIFT',
    ControlLeft: 'L CTRL',
    ControlRight: 'R CTRL',
    AltLeft: 'L ALT',
    AltRight: 'R ALT',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Semicolon: ';',
    Quote: "'",
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Minus: '-',
    Equal: '=',
    Backquote: '`',
  };
  return named[code] ?? code.toUpperCase();
}

// -- persistence -----------------------------------------------------------

const STORAGE_KEY = 'retro.controls.v1';

interface StoredProfile {
  bindings?: Record<string, unknown>;
  deadzone?: unknown;
  rest?: Record<string, unknown>;
  range?: Record<string, unknown>;
}

/**
 * Read the saved profile, falling back to defaults on anything at all.
 *
 * localStorage throws outright in a partitioned or storage-blocked context, and
 * whatever is in there was written by an older build of this file. Neither is
 * worth a broken page: an unreadable profile is a default profile.
 */
export function loadProfile(): ControlProfile {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return defaultProfile();
  }
  if (!raw) return defaultProfile();
  try {
    return sanitize(JSON.parse(raw) as StoredProfile);
  } catch {
    return defaultProfile();
  }
}

export function saveProfile(profile: ControlProfile): void {
  const stored: StoredProfile = {
    bindings: Object.fromEntries(BUTTON_NAMES.map((n) => [n, profile.bindings[n].map(tokenOf)])),
    deadzone: profile.deadzone,
    rest: profile.rest,
    range: profile.range,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Private mode, a full quota, a blocked origin. The profile still applies
    // for this session; it simply will not outlive the tab.
  }
}

function sanitize(stored: StoredProfile): ControlProfile {
  const fallback = defaultProfile();
  const bindings = {} as Record<ButtonName, Binding[]>;
  for (const name of BUTTON_NAMES) {
    const tokens = stored.bindings?.[name];
    if (!Array.isArray(tokens)) {
      // A button the saved profile never heard of: it is new, so it keeps its
      // default rather than arriving unbound.
      bindings[name] = [...fallback.bindings[name]];
      continue;
    }
    const seen = new Set<string>();
    bindings[name] = [];
    for (const token of tokens) {
      if (typeof token !== 'string') continue;
      const binding = parseToken(token);
      if (!binding || seen.has(token)) continue;
      seen.add(token);
      bindings[name].push(binding);
    }
  }

  const deadzone =
    typeof stored.deadzone === 'number' && Number.isFinite(stored.deadzone)
      ? clamp(stored.deadzone, MIN_DEADZONE, MAX_DEADZONE)
      : fallback.deadzone;

  const rest: Record<string, number[]> = {};
  for (const [id, axes] of Object.entries(stored.rest ?? {})) {
    if (!Array.isArray(axes)) continue;
    rest[id] = axes.map((v) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, -1, 1) : 0));
  }

  /*
   * A pair that is not a pair, or one that does not straddle zero, is not a
   * measurement of anything — it becomes the identity rather than a divisor,
   * because dividing live axis values by a number this file invented is how a
   * stick ends up twitching at rest.
   */
  const range: Record<string, Array<readonly [number, number]>> = {};
  for (const [id, axes] of Object.entries(stored.range ?? {})) {
    if (!Array.isArray(axes)) continue;
    range[id] = axes.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) return NO_TRAVEL;
      const [lo, hi] = pair as [unknown, unknown];
      if (typeof lo !== 'number' || typeof hi !== 'number') return NO_TRAVEL;
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return NO_TRAVEL;
      if (lo > 0 || hi < 0) return NO_TRAVEL;
      return [clamp(lo, -2, 0), clamp(hi, 0, 2)] as const;
    });
  }

  return { bindings, deadzone, rest, range };
}

/** "Measured nothing" — scale by this and the axis is left exactly as it came. */
export const NO_TRAVEL: readonly [number, number] = [-1, 1];

/**
 * Below this much travel we refuse to scale.
 *
 * A stick that only reported 0.15 either was not swept or is broken, and
 * dividing by 0.15 turns its resting jitter into a permanent hard direction.
 */
export const MIN_TRAVEL = 0.35;

/**
 * Put a raw axis on a full-scale ±1, given what this pad actually does.
 *
 * Rest first, then travel, then clamp — the order matters, since travel is
 * measured relative to rest and applying it to an uncentred value would scale
 * the offset along with the signal.
 */
export function correctAxis(raw: number, rest: number, travel: readonly [number, number]): number {
  const centred = raw - rest;
  const reach = centred < 0 ? -travel[0] : travel[1];
  const scaled = reach >= MIN_TRAVEL ? centred / reach : centred;
  return clamp(scaled, -2, 2);
}

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
