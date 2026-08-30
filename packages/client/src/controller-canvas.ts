/**
 * The controller, drawn, lighting up as you touch it.
 *
 * A console shows you a picture of the pad in your hands and lights the thing
 * you just pressed. That is worth copying for one specific reason: it answers
 * "is this stick drifting, or is the game wrong" without the player needing to
 * know what an axis is. A row of numbers cannot do that. A picture can.
 *
 * Canvas rather than SVG because this repaints every frame against a live
 * device: seventeen buttons and four axes as DOM nodes means seventeen style
 * writes a frame and a layout pass the compositor did not need. One `draw` call
 * into a bitmap costs nothing and never touches layout.
 *
 * The drawing is schematic on purpose — hairline seams, one warm accent — so it
 * belongs to the same dark room as the rest of the page rather than looking
 * like a product photo dropped into it.
 */
import { BUTTON_GLYPH } from './emulator/bindings.js';
import type { ButtonName } from './emulator/input.js';
import type { PadSnapshot } from './emulator/controls.js';

/**
 * Where each standard-mapping control sits, in a fixed 340x200 space that is
 * scaled to whatever the canvas actually is.
 *
 * These indices are the W3C standard gamepad mapping, and they are only
 * meaningful when the browser says `mapping === 'standard'`. When it does not,
 * nothing here applies and `drawGeneric` runs instead — a made-up picture of the
 * wrong pad would be worse than no picture.
 */
const W = 340;
const H = 200;

interface Round {
  readonly kind: 'round';
  readonly x: number;
  readonly y: number;
  readonly r: number;
}
interface Bar {
  readonly kind: 'bar';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
type Shape = Round | Bar;

/**
 * Which side of a control its "what this does in the game" label goes.
 *
 * Every one of these is a collision that happened. A d-pad whose four labels
 * all sit underneath their arms writes them on top of each other in the middle
 * of the cross; a trigger labelled below is labelled on top of the shoulder
 * button under it. So placement is per control rather than a rule.
 */
type LabelAt = 'above' | 'below' | 'left' | 'right';

/** Button index -> where it is drawn, what the pad calls it, where its label goes. */
const BUTTONS: Readonly<Record<number, { shape: Shape; face: string; at: LabelAt }>> = {
  0: { shape: { kind: 'round', x: 262, y: 126, r: 12 }, face: 'A', at: 'below' },
  1: { shape: { kind: 'round', x: 286, y: 102, r: 12 }, face: 'B', at: 'right' },
  2: { shape: { kind: 'round', x: 238, y: 102, r: 12 }, face: 'X', at: 'left' },
  3: { shape: { kind: 'round', x: 262, y: 78, r: 12 }, face: 'Y', at: 'above' },
  4: { shape: { kind: 'bar', x: 52, y: 26, w: 58, h: 15 }, face: 'LB', at: 'below' },
  5: { shape: { kind: 'bar', x: 230, y: 26, w: 58, h: 15 }, face: 'RB', at: 'below' },
  6: { shape: { kind: 'bar', x: 58, y: 5, w: 46, h: 14 }, face: 'LT', at: 'left' },
  7: { shape: { kind: 'bar', x: 236, y: 5, w: 46, h: 14 }, face: 'RT', at: 'right' },
  8: { shape: { kind: 'bar', x: 124, y: 88, w: 26, h: 12 }, face: 'BACK', at: 'below' },
  9: { shape: { kind: 'bar', x: 170, y: 88, w: 26, h: 12 }, face: 'START', at: 'below' },
  12: { shape: { kind: 'bar', x: 119, y: 124, w: 18, h: 17 }, face: '', at: 'above' },
  13: { shape: { kind: 'bar', x: 119, y: 157, w: 18, h: 17 }, face: '', at: 'below' },
  14: { shape: { kind: 'bar', x: 102, y: 141, w: 17, h: 16 }, face: '', at: 'left' },
  15: { shape: { kind: 'bar', x: 137, y: 141, w: 17, h: 16 }, face: '', at: 'right' },
  16: { shape: { kind: 'round', x: 147, y: 64, r: 8 }, face: '', at: 'above' },
};

/**
 * The two sticks.
 *
 * `button` is the stick-click, which is drawn as the gate ring lighting up
 * rather than as a shape of its own — a circle at the stick's centre would sit
 * underneath the stick dot and be invisible exactly when it was pressed.
 */
const STICKS = [
  { x: 84, y: 102, r: 23, axes: [0, 1] as const, button: 10, name: 'L' },
  { x: 208, y: 150, r: 23, axes: [2, 3] as const, button: 11, name: 'R' },
];

export interface PadView {
  readonly pad: PadSnapshot | null;
  readonly deadzone: number;
  /**
   * What a physical control drives, by token — so the picture doubles as the
   * mapping, the way a console's does. Null for anything unbound.
   */
  readonly labelFor: (token: string) => string | null;
  /** Draw the sticks as the thing being asked for right now. */
  readonly askingForSticks: boolean;
}

interface Palette {
  ink: string;
  dim: string;
  faint: string;
  line: string;
  lineLit: string;
  panel: string;
  panelLit: string;
  well: string;
  coin: string;
  coinHot: string;
}

export class ControllerCanvas {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  #palette: Palette;
  /** Backing-store size actually in place, so resizing is not done per frame. */
  #sized = '';

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('this browser gave us no 2d canvas context');
    this.#canvas = canvas;
    this.#ctx = ctx;
    this.#palette = readPalette();
  }

  /** The page's own tokens, so the pad is lit by the same palette as the room. */
  refreshPalette(): void {
    this.#palette = readPalette();
  }

  draw(view: PadView): void {
    const ctx = this.#ctx;
    this.#resize();
    const { width, height } = this.#canvas.getBoundingClientRect();
    ctx.save();
    ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    const dpr = window.devicePixelRatio || 1;
    ctx.scale(dpr, dpr);
    // One logical space, whatever the element's size: everything below is
    // written against 340x200 and never has to think about layout.
    const scale = Math.min(width / W, height / H);
    ctx.translate((width - W * scale) / 2, (height - H * scale) / 2);
    ctx.scale(scale, scale);

    if (!view.pad) this.#drawEmpty();
    else if (view.pad.standard) this.#drawStandard(view, view.pad);
    else this.#drawGeneric(view, view.pad);
    ctx.restore();
  }

  #resize(): void {
    const rect = this.#canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const key = `${rect.width}x${rect.height}@${dpr}`;
    if (key === this.#sized) return;
    this.#sized = key;
    this.#canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.#canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  // -- the standard pad ------------------------------------------------------

  #drawStandard(view: PadView, pad: PadSnapshot): void {
    this.#drawBody();
    for (const [index, spec] of Object.entries(BUTTONS)) {
      const i = Number(index);
      // A pad with fewer buttons than the standard layout still draws the ones
      // it has; the rest simply are not there to light up.
      if (i >= pad.buttons.length) continue;
      this.#drawButton(
        spec.shape,
        pad.buttons[i] === true,
        spec.face,
        view.labelFor(`btn:${i}`),
        spec.at,
      );
    }
    for (const stick of STICKS) {
      const [ax, ay] = stick.axes;
      if (ax >= pad.corrected.length) continue;
      this.#drawStick(view, pad, stick, pad.corrected[ax] ?? 0, pad.corrected[ay] ?? 0);
    }
  }

  /**
   * The silhouette, drawn once behind everything.
   *
   * The curve is chosen to enclose the control positions above rather than to
   * look like any particular manufacturer's pad — a stick drawn half outside
   * its own body is the one thing that makes the whole picture read as broken.
   */
  #drawBody(): void {
    const ctx = this.#ctx;
    const p = this.#palette;
    ctx.beginPath();
    ctx.moveTo(34, 104);
    ctx.bezierCurveTo(38, 62, 100, 48, 170, 48);
    ctx.bezierCurveTo(240, 48, 302, 62, 306, 104);
    ctx.bezierCurveTo(316, 144, 296, 182, 256, 184);
    ctx.bezierCurveTo(226, 186, 214, 168, 196, 158);
    ctx.bezierCurveTo(184, 152, 156, 152, 144, 158);
    ctx.bezierCurveTo(126, 168, 114, 186, 84, 184);
    ctx.bezierCurveTo(44, 182, 24, 144, 34, 104);
    ctx.closePath();
    ctx.fillStyle = p.panel;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = p.lineLit;
    ctx.stroke();
  }

  #drawButton(
    shape: Shape,
    pressed: boolean,
    face: string,
    bound: string | null,
    at: LabelAt,
  ): void {
    const ctx = this.#ctx;
    const p = this.#palette;
    ctx.beginPath();
    if (shape.kind === 'round') ctx.arc(shape.x, shape.y, shape.r, 0, Math.PI * 2);
    else ctx.roundRect(shape.x, shape.y, shape.w, shape.h, 4);
    // Pressed is the only warm thing on the pad, which is what makes it findable
    // out of the corner of an eye while you are looking at your hands.
    ctx.fillStyle = pressed ? p.coin : p.panelLit;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = pressed ? p.coinHot : p.line;
    ctx.stroke();

    const cx = shape.kind === 'round' ? shape.x : shape.x + shape.w / 2;
    const cy = shape.kind === 'round' ? shape.y : shape.y + shape.h / 2;
    const halfW = shape.kind === 'round' ? shape.r : shape.w / 2;
    const halfH = shape.kind === 'round' ? shape.r : shape.h / 2;

    if (face) {
      ctx.fillStyle = pressed ? '#1a1200' : p.faint;
      ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(face, cx, cy);
    }
    if (!bound) return;
    // What it actually does in the game — the half that makes the picture a
    // mapping rather than only a tester.
    ctx.fillStyle = pressed ? p.coinHot : p.dim;
    ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    switch (at) {
      case 'above':
        ctx.textAlign = 'center';
        ctx.fillText(bound, cx, cy - halfH - 7);
        break;
      case 'below':
        ctx.textAlign = 'center';
        ctx.fillText(bound, cx, cy + halfH + 7);
        break;
      case 'left':
        ctx.textAlign = 'right';
        ctx.fillText(bound, cx - halfW - 5, cy);
        break;
      case 'right':
        ctx.textAlign = 'left';
        ctx.fillText(bound, cx + halfW + 5, cy);
        break;
    }
  }

  #drawStick(
    view: PadView,
    pad: PadSnapshot,
    stick: (typeof STICKS)[number],
    x: number,
    y: number,
  ): void {
    const ctx = this.#ctx;
    const p = this.#palette;
    const live = Math.hypot(x, y) >= view.deadzone;
    const clicked = pad.buttons[stick.button] === true;

    // The gate: how far the stick can go, after calibration. It doubles as the
    // stick-click, which has nowhere of its own to live — a shape at the centre
    // would be underneath the stick dot exactly when it was pressed.
    ctx.beginPath();
    ctx.arc(stick.x, stick.y, stick.r, 0, Math.PI * 2);
    ctx.fillStyle = clicked ? 'rgba(255, 200, 61, 0.18)' : p.well;
    ctx.fill();
    ctx.lineWidth = clicked || view.askingForSticks ? 2 : 1;
    ctx.strokeStyle = clicked ? p.coin : view.askingForSticks ? p.coin : p.lineLit;
    ctx.stroke();

    // The deadzone, dashed, so "inside this, nothing happens" is a thing you can
    // see the dot sitting in rather than a number you have to trust.
    ctx.beginPath();
    ctx.arc(stick.x, stick.y, stick.r * view.deadzone, 0, Math.PI * 2);
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = p.faint;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // The stick itself. Clamped to the gate so an over-travelling axis stays
    // inside the picture instead of drawing over the buttons.
    const reach = Math.min(1, Math.hypot(x, y));
    const angle = Math.atan2(y, x);
    const dx = stick.x + Math.cos(angle) * reach * stick.r;
    const dy = stick.y + Math.sin(angle) * reach * stick.r;
    ctx.beginPath();
    ctx.moveTo(stick.x, stick.y);
    ctx.lineTo(dx, dy);
    ctx.strokeStyle = live ? p.coin : p.line;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(dx, dy, 7, 0, Math.PI * 2);
    ctx.fillStyle = live ? p.coin : p.panelLit;
    ctx.fill();
    ctx.strokeStyle = live ? p.coinHot : p.lineLit;
    ctx.lineWidth = 1;
    ctx.stroke();

    /*
     * Name and mapping on one line above the gate.
     *
     * Above rather than below because below is where the d-pad and the right
     * grip are, and the glyphs for a fully bound stick are wide enough to reach
     * both. The four directions are glyphs for the same reason — spelled out
     * they are wider than the controller.
     */
    const directions = this.#stickLegend(view, stick);
    ctx.fillStyle = directions ? p.dim : p.faint;
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      directions ? `${stick.name} ${directions}` : stick.name,
      stick.x,
      stick.y - stick.r - 9,
    );
  }

  /** The glyphs for whatever this stick's two axes are bound to, in order. */
  #stickLegend(view: PadView, stick: (typeof STICKS)[number]): string {
    const glyphs: string[] = [];
    for (const axis of stick.axes) {
      for (const dir of ['-', '+']) {
        const name = view.labelFor(`axis:${axis}${dir}`);
        if (!name) continue;
        const glyph = BUTTON_GLYPH[name as ButtonName];
        const shown = glyph ?? name;
        if (!glyphs.includes(shown)) glyphs.push(shown);
      }
    }
    return glyphs.join('');
  }

  // -- everything else -------------------------------------------------------

  /**
   * A pad the browser did not recognise.
   *
   * No silhouette, because we do not know what it looks like and a drawing of
   * the wrong controller is worse than none — the same reason `describeBinding`
   * falls back to a bare index. Buttons become numbered pips and axes become
   * bars, which is exactly as much as the browser is actually telling us.
   */
  #drawGeneric(view: PadView, pad: PadSnapshot): void {
    const ctx = this.#ctx;
    const p = this.#palette;
    ctx.fillStyle = p.faint;
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('unrecognised layout — buttons and axes as reported', 12, 12);

    const perRow = 9;
    for (let i = 0; i < Math.min(pad.buttons.length, 36); i += 1) {
      const x = 20 + (i % perRow) * 34;
      const y = 36 + Math.floor(i / perRow) * 30;
      this.#drawButton({ kind: 'round', x, y, r: 11 }, pad.buttons[i] === true, String(i), null, 'below');
      const bound = view.labelFor(`btn:${i}`);
      if (bound) {
        ctx.fillStyle = p.dim;
        ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(bound, x, y + 18);
      }
    }

    const top = 36 + Math.ceil(Math.min(pad.buttons.length, 36) / perRow) * 30 + 8;
    for (let i = 0; i < Math.min(pad.corrected.length, 8); i += 1) {
      const y = top + i * 16;
      const value = Math.max(-1, Math.min(1, pad.corrected[i] ?? 0));
      ctx.fillStyle = p.faint;
      ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`AX${i}`, 40, y);

      ctx.beginPath();
      ctx.roundRect(48, y - 4, 240, 8, 4);
      ctx.fillStyle = p.well;
      ctx.fill();
      ctx.strokeStyle = p.line;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Grows out of the centre, so a resting axis is a flat line and a
      // drifting one visibly is not.
      const mid = 48 + 120;
      const w = Math.abs(value) * 120;
      ctx.beginPath();
      ctx.roundRect(value >= 0 ? mid : mid - w, y - 3, Math.max(w, 1), 6, 3);
      ctx.fillStyle = Math.abs(value) >= view.deadzone ? p.coin : p.line;
      ctx.fill();

      ctx.fillStyle = p.dim;
      ctx.textAlign = 'left';
      ctx.fillText(value.toFixed(2), 294, y);
    }
  }

  #drawEmpty(): void {
    const ctx = this.#ctx;
    const p = this.#palette;
    this.#drawBody();
    ctx.fillStyle = p.faint;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('press a button on your gamepad', W / 2, 104);
    ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('browsers hide a pad until it is used', W / 2, 120);
  }
}

/**
 * Read the page's palette once, rather than hardcoding hexes here.
 *
 * The stylesheet is where this project's colour discipline lives — blue
 * surfaces, one warm accent — and a canvas that carried its own copy would
 * drift away from it the first time a token changed.
 */
function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string =>
    css.getPropertyValue(name).trim() || fallback;
  return {
    ink: read('--ink', '#e9eef9'),
    dim: read('--dim', '#97a3c2'),
    faint: read('--faint', '#5d6a8c'),
    line: read('--line', '#1c2846'),
    lineLit: read('--line-lit', '#2c3b64'),
    panel: read('--panel', '#0c1322'),
    panelLit: read('--panel-lit', '#121b30'),
    well: read('--well', '#070c17'),
    coin: read('--coin', '#ffc83d'),
    coinHot: read('--coin-hot', '#ffe08a'),
  };
}
