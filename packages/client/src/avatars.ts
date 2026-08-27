import { AVATAR_IDS, DEFAULT_AVATAR } from '@dino/shared';
import type { AvatarId } from '@dino/shared';

/**
 * The drawings behind the ten avatar ids.
 *
 * Silhouettes only, in the same flat `currentColor` style as the marquee art in
 * index.html, and inline for the same reason: a clone of this repo has no image
 * to fetch and no font to wait for. Each path is drawn inside a 64x64 box.
 *
 * They are tinted by whatever colour the surrounding element sets, which is how
 * a seated player's avatar picks up its `--p1`/`--p2`/`--p3`.
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
  raptor: {
    name: 'Raptor',
    path:
      'M40 8c6 0 10 4 11 9l7 3-7 2c0 4-2 7-5 9l3 12c1 5-1 10-5 13l4 8h-9l-4-8-6 1-3 7h-9l4-10' +
      'c-5-3-8-9-8-15 0-8 5-15 12-19l-9-6 11-1-4-7 9 4c2-2 5-3 8-3zm2 8a3 3 0 100 6 3 3 0 000-6z',
  },
  trike: {
    name: 'Triceratops',
    path:
      'M12 30c0-9 8-16 19-16 6 0 11 2 15 6l6-9 2 11 9-4-6 9 8 3-9 3c0 8-6 14-14 16l3 9h-8l-3-8' +
      'h-6l-3 8h-8l3-10c-5-3-8-9-8-18zm30-6a3 3 0 100 6 3 3 0 000-6z',
  },
  sauropod: {
    name: 'Sauropod',
    path:
      'M18 56l2-14c-6-3-9-9-9-15 0-9 8-16 18-16 7 0 13 3 16 9l8-14c3 5 2 12-2 17l-4 4c0 8-5 15-13 18' +
      'l2 11h-7l-2-9h-4l-2 9zm7-32a3 3 0 100 6 3 3 0 000-6z',
  },
  pterosaur: {
    name: 'Pterosaur',
    path:
      // Straight lines only, and symmetric about x=32: swept wings either side
      // of a crested head, split tail below. Curves at this size read as mush.
      'M32 20L36 27L58 18L46 30L56 34L40 33L36 38L38 48L32 40L26 48L28 38L24 33L8 34L18 30L6 18L28 27Z',
  },
  ankylosaur: {
    name: 'Ankylosaur',
    path:
      'M8 42c0-11 9-20 22-20 8 0 15 4 19 10l11-6-4 9 6 6-9 2c-2 8-9 13-18 14l2 7h-7l-2-6h-6l-2 6h-7' +
      'l2-8c-8-2-13-8-13-14zm12-8l4-6 4 6zm12-2l4-6 4 6z',
  },
  cadillac: {
    name: 'Cadillac',
    path:
      'M6 44l3-10c1-4 5-6 10-7l9-9c2-2 5-3 8-3h8c4 0 7 2 9 5l6 10c3 1 5 3 5 6v8h-8a7 7 0 00-14 0H28' +
      'a7 7 0 00-14 0zm14-16h13v-9h-5zm19 0h11l-5-9h-6zM21 44a4 4 0 108 0 4 4 0 00-8 0zm26 0a4 4 0 108 0 4 4 0 00-8 0z',
  },
  cutlass: {
    name: 'Cutlass',
    path:
      'M55 6c3 9 1 19-5 27L28 51l-4-4 22-18c5-6 8-14 9-23zM22 45l-3 5-8 6 5-9 4-4zm4-6L14 51l-3-3 12-12z',
  },
  cycad: {
    name: 'Cycad',
    path:
      'M30 58V38c-5 3-12 3-17-1 4-5 11-6 17-3v-5c-6-1-11-6-12-13 7 1 11 6 13 12 1-7 5-13 11-16' +
      ' 2 7 0 14-6 18v5c6-4 13-4 18 1-5 5-12 5-18 2v20zm2-30a2 2 0 100 4 2 2 0 000-4z',
  },
  skull: {
    name: 'Skull',
    path:
      'M32 6c13 0 22 9 22 21 0 7-3 13-8 17v8l-4 3-3-4-3 4-4-4-3 4-4-3v-8c-5-4-8-10-8-17 0-12 9-21 15-21z' +
      'M24 26a5 5 0 1010 0 5 5 0 00-10 0zm16 0a5 5 0 1010 0 5 5 0 00-10 0zm-8 12l3 6h-6z',
  },
  volcano: {
    name: 'Volcano',
    path:
      'M4 54l18-30h20l18 30zm22-30l2-8-6-6 9 2 3-8 3 8 9-2-6 6 2 8zm-4 30l6-12 5 7 4-5 5 10z',
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
