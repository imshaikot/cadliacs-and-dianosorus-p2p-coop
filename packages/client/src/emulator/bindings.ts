/**
 * What a physical control *is*, independent of what it does.
 *
 * A binding is one source: a keyboard key, a gamepad button, or one direction
 * of one gamepad axis. Every game button holds a list of them, so ATTACK can be
 * Z *and* the pad's A button at the same time without either knowing about the
 * other — which is what lets someone plug a stick in mid-session and keep the
 * keyboard as a fallback.
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
   * This is the calibration. A worn stick rests at 0.12 rather than 0, and an
   * Xbox trigger rests at -1 by design; subtracting the measured rest turns
   * both into "0 means untouched" without any per-device special-casing.
   */
  readonly rest: Readonly<Record<string, readonly number[]>>;
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
  ATTACK: '✕',
  JUMP: '⬆',
  COIN: '◎',
  START: '▶',
};

/**
 * Defaults.
 *
 * The keyboard half is derived from DEFAULT_KEYMAP rather than restated, so the
 * arcade conventions (5 coins, 1 starts) have exactly one home. The pad half is
 * the standard mapping's d-pad and left stick, with attack on A and jump on B
 * because that is the order a thumb finds them in.
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
    ATTACK: [{ source: 'pad-button', index: 0 }],
    JUMP: [{ source: 'pad-button', index: 1 }],
    COIN: [{ source: 'pad-button', index: 8 }],
    START: [{ source: 'pad-button', index: 9 }],
  };
  for (const name of BUTTON_NAMES) out[name].push(...pad[name]);
  return out;
}

export function defaultProfile(): ControlProfile {
  return { bindings: defaultBindings(), deadzone: 0.35, rest: {} };
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

const STORAGE_KEY = 'dino.controls.v1';

interface StoredProfile {
  bindings?: Record<string, unknown>;
  deadzone?: unknown;
  rest?: Record<string, unknown>;
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

  return { bindings, deadzone, rest };
}

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
