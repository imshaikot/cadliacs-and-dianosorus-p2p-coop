import { AVATAR_IDS, DEFAULT_AVATAR } from '@retro/shared';
import type { AvatarId } from '@retro/shared';

/**
 * The drawings behind the ten avatar ids.
 *
 * Silhouettes only, flat `currentColor`, inline so a clone of this repo has no
 * image to fetch and no font to wait for. Each path is drawn inside a 64x64 box.
 *
 * They are tinted by whatever colour the surrounding element sets, which is how
 * a seated player's avatar picks up its `--p1`/`--p2`/`--p3`.
 *
 * Deliberately generic arcade furniture — a joystick, a coin, a cabinet — rather
 * than characters from any one game. The platform runs whatever you load into
 * it, so its faces should not belong to a single title.
 */
interface AvatarArt {
  /** Shown under the swatch in the picker, and read out to screen readers. */
  name: string;
  /**
   * When a path is split across lines, the continuation must start with a
   * command letter or a space. Without one the concatenation runs the last
   * number of one line into the first of the next — `…11-16` + `2 7…` becomes
   * `…11-162 7…`, which the browser rejects and draws nothing for.
   */
  path: string;
}

const ART: Record<AvatarId, AvatarArt> = {
  joystick: {
    name: 'Joystick',
    path:
      'M32 5a10 10 0 110 20 10 10 0 010-20zM28 26h8v16h-8zM10 52c0-7 10-12 22-12s22 5 22 12v3' +
      'c0 3-10 4-22 4s-22-1-22-4z',
  },
  coin: {
    name: 'Coin',
    path:
      // Ring plus a slot. The inner circle and the slot are wound the opposite
      // way from the outer circle so nonzero fill knocks them out as holes.
      'M32 4a28 28 0 100 56 28 28 0 000-56zm0 7a21 21 0 010 42 21 21 0 010-42z' +
      'M29 18h6v28h-6z',
  },
  cabinet: {
    name: 'Cabinet',
    path:
      'M14 4h36c3 0 5 2 5 5v46c0 3-2 5-5 5H14c-3 0-5-2-5-5V9c0-3 2-5 5-5zm4 8v18h28V12zm0 24v6h28v-6z' +
      'm3 12a3 3 0 106 0 3 3 0 00-6 0zm10 0a3 3 0 106 0 3 3 0 00-6 0z',
  },
  alien: {
    name: 'Alien',
    path:
      'M32 6c11 0 19 8 19 19 0 8-4 15-11 19l3 14h-7l-2-9h-4l-2 9h-7l3-14c-7-4-11-11-11-19 0-11 8-19 19-19z' +
      'M24 22a4 5 0 108 0 4 5 0 00-8 0zm16 0a4 5 0 108 0 4 5 0 00-8 0z',
  },
  rocket: {
    name: 'Rocket',
    path:
      'M32 4c8 8 12 18 12 29v9H20v-9c0-11 4-21 12-29zM20 34L8 46l4 10 8-6zm24 0l12 12-4 10-8-6z' +
      'M28 46h8v8l-4 6-4-6zm4-30a5 5 0 110 10 5 5 0 010-10z',
  },
  robot: {
    name: 'Robot',
    path:
      'M30 2h4v8h8c4 0 6 2 6 6v26c0 4-2 6-6 6H22c-4 0-6-2-6-6V16c0-4 2-6 6-6h8zM10 22h4v18h-4z' +
      'm40 0h4v18h-4zM24 22a4 4 0 108 0 4 4 0 00-8 0zm16 0a4 4 0 108 0 4 4 0 00-8 0zM24 36h16v5H24z' +
      'M22 54h8v8h-8zm12 0h8v8h-8z',
  },
  star: {
    name: 'Star',
    path: 'M32 4l8 19 21 2-16 14 5 21-18-11-18 11 5-21L4 25l21-2z',
  },
  skull: {
    name: 'Skull',
    path:
      'M32 6c13 0 22 9 22 21 0 7-3 13-8 17v8l-4 3-3-4-3 4-4-4-3 4-4-3v-8c-5-4-8-10-8-17 0-12 9-21 15-21z' +
      'M24 26a5 5 0 1010 0 5 5 0 00-10 0zm16 0a5 5 0 1010 0 5 5 0 00-10 0zm-8 12l3 6h-6z',
  },
  bolt: {
    name: 'Bolt',
    path: 'M38 2L14 34h14l-6 28 26-34H33z',
  },
  heart: {
    name: 'Heart',
    path:
      'M32 58S6 42 6 24C6 14 13 7 22 7c5 0 9 2 10 6 1-4 5-6 10-6 9 0 16 7 16 17 0 18-26 34-26 34z',
  },
};

export function avatarName(id: AvatarId): string {
  return ART[id].name;
}

/**
 * One `<symbol>` per avatar, dropped into the page once so every swatch and
 * roster row is a `<use href="#av-…">` rather than a fresh copy of the path.
 */
export function avatarDefs(): string {
  return AVATAR_IDS.map(
    (id) => `<symbol id="av-${id}" viewBox="0 0 64 64"><path d="${ART[id].path}" /></symbol>`,
  ).join('');
}

/** An `<svg>` referencing one of those symbols. Caller supplies the class. */
export function avatarSvg(id: AvatarId, className: string): SVGSVGElement {
  const known = id in ART ? id : DEFAULT_AVATAR;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#av-${known}`);
  svg.append(use);
  return svg;
}
