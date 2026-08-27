/**
 * Fullscreen acceptance: the game screen can own the display.
 *
 * Three traps this had to be written around, all of them things that were got
 * wrong first:
 *
 *   - `getBoundingClientRect()` on the canvas measures the ELEMENT BOX, not the
 *     picture. In fullscreen that box is deliberately the whole screen and
 *     `object-fit: contain` letterboxes the 384x224 inside it, so a box whose
 *     aspect ratio is 16:9 is correct, not stretched. Assert the two halves
 *     that produce letterboxing instead of measuring the wrong rectangle.
 *   - Fullscreen is gated on user activation, so every toggle here goes through
 *     a real trusted click or key event. A synthetic `.click()` silently does
 *     nothing and the check would fail for the wrong reason.
 *   - The clock has to survive the round trip. Entering fullscreen resizes and
 *     recomposites; if that ever stalled the audio-thread metronome, a host
 *     would stop publishing input and freeze the game for everyone. Frame
 *     counts are sampled either side of both transitions.
 *
 * Not covered: the rule that keeps a live desync count on screen while the rest
 * of the HUD fades out. Forcing a real desync needs a second peer deliberately
 * fed bad input, which belongs in a netplay check rather than this one.
 */
import { mkdirSync } from 'node:fs';
import { launchChrome, connectBrowser, warmUp, Tab, sleep } from './cdp.mjs';
import { hostGame } from './app.mjs';
import { KEYS, bit } from './keys.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5173/';
const OUT = new URL('./shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const FKEY = { code: 'KeyF', key: 'f', vk: 70 };

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Everything about the stage that a fullscreen transition can change. */
const GEOM = `(() => {
  const wrap = document.getElementById('stage-wrap');
  const canvas = document.getElementById('screen');
  const btn = document.getElementById('btn-fullscreen');
  const w = wrap.getBoundingClientRect();
  const c = canvas.getBoundingClientRect();
  const s = document.getElementById('stage').getBoundingClientRect();
  const h = document.querySelector('.hud-rows').getBoundingClientRect();
  return {
    fullscreen: document.fullscreenElement === wrap,
    idle: wrap.dataset.idle ?? null,
    wrap: { w: Math.round(w.width), h: Math.round(w.height) },
    stage: { w: Math.round(s.width), h: Math.round(s.height) },
    canvas: { w: Math.round(c.width), h: Math.round(c.height) },
    hud: { top: Math.round(h.top), bottom: Math.round(h.bottom) },
    objectFit: getComputedStyle(canvas).objectFit,
    intrinsic: { w: canvas.width, h: canvas.height },
    hudOpacity: Number(getComputedStyle(document.querySelector('.hud-rows')).opacity),
    cursor: getComputedStyle(wrap).cursor,
    btnHidden: btn.hidden,
    btnLabel: btn.textContent,
    btnPressed: btn.getAttribute('aria-pressed'),
    viewport: { w: innerWidth, h: innerHeight },
  };
})()`;

const { port, kill } = await launchChrome({ headless: true });
const conn = await connectBrowser(port);
console.log(`warming the dev server… ${await warmUp(conn, APP)}ms`);
let failure = null;

try {
  const host = await Tab.create(conn, APP, 'HOST');
  await hostGame(host, { name: 'Jack Tenrec', avatar: 'raptor' });
  await host.waitFor('window.__retro.snapshot().emulator?.running', 120000, 'emulator running');
  await sleep(800);

  const windowed = await host.eval(GEOM);
  check('the control appears once there is a picture to enlarge', windowed.btnHidden === false);
  check('nothing is fullscreen at rest',
    windowed.fullscreen === false && windowed.idle === null && windowed.btnPressed === 'false');

  // --- in, by a real click on the button -----------------------------------
  await host.clickSelector('#btn-fullscreen');
  await host.waitFor('window.__retro.snapshot().fullscreen === true', 5000, 'fullscreen');
  await sleep(400);
  const full = await host.eval(GEOM);
  check('a real click enters fullscreen', full.fullscreen === true);
  check('__retro.snapshot() reports it, so other checks can wait on it',
    (await host.eval('window.__retro.snapshot().fullscreen')) === true);
  check('the control relabels and reports its state',
    full.btnLabel === 'exit' && full.btnPressed === 'true', `"${full.btnLabel}"`);
  check('the wrapper fills the viewport',
    full.wrap.w === full.viewport.w && full.wrap.h === full.viewport.h,
    `${full.wrap.w}x${full.wrap.h} in ${full.viewport.w}x${full.viewport.h}`);

  // See the header: measure what letterboxes, not the box that gets letterboxed.
  check('the picture is contained, never stretched',
    full.objectFit === 'contain' && full.intrinsic.w === 384 && full.intrinsic.h === 224,
    `object-fit: ${full.objectFit}, intrinsic ${full.intrinsic.w}x${full.intrinsic.h}`);
  check('the canvas gets the whole stage, so the picture is as large as it can be',
    Math.abs(full.canvas.w - full.stage.w) < 3 && Math.abs(full.canvas.h - full.stage.h) < 3,
    `canvas ${full.canvas.w}x${full.canvas.h} in stage ${full.stage.w}x${full.stage.h}`);
  check('and the stage grew to one whole viewport axis',
    full.canvas.h > windowed.canvas.h &&
      (Math.abs(full.canvas.w - full.viewport.w) < 3 || Math.abs(full.canvas.h - full.viewport.h) < 3),
    `${windowed.canvas.w}x${windowed.canvas.h} -> ${full.canvas.w}x${full.canvas.h}`);

  // The HUD carries the desync count, so it has to come along rather than being
  // left behind on the page — and it must not cost the picture any height.
  check('the HUD comes along and sits at the foot of the screen',
    Math.abs(full.hud.bottom - full.viewport.h) < 2 && full.hud.top < full.viewport.h,
    `hud bottom ${full.hud.bottom}, viewport ${full.viewport.h}`);
  check('the HUD overlays the picture rather than stealing height from it',
    full.stage.h === full.viewport.h, `stage ${full.stage.h}, viewport ${full.viewport.h}`);
  await host.screenshot(OUT + 'fullscreen-active.png');

  // --- the furniture gets out of the way, then comes back ------------------
  // `data-idle` flips the instant the timer fires, but the fade is a 200ms
  // transition — sampling opacity on the attribute catches it mid-flight. Wait
  // on the settled value, which is the durable fact.
  await host.waitFor(
    'getComputedStyle(document.querySelector(".hud-rows")).opacity === "0"',
    8000,
    'the HUD to finish fading',
  );
  const idle = await host.eval(GEOM);
  check('a still pointer fades the HUD out', idle.hudOpacity === 0, `opacity ${idle.hudOpacity}`);
  check('and hides the cursor', idle.cursor === 'none', idle.cursor);

  await conn.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: Math.round(idle.viewport.w / 2), y: Math.round(idle.viewport.h / 2), buttons: 0 },
    host.sessionId,
  );
  await sleep(300);
  const woken = await host.eval(GEOM);
  check('a mouse move brings it all back', woken.idle === null && woken.hudOpacity === 1);

  // --- the keyboard toggle, and what it must not do ------------------------
  const beforeToggle = await host.eval('window.__retro.machine().frame');
  await host.holdKey(FKEY, 60);
  await host.waitFor('window.__retro.snapshot().fullscreen === false', 5000, 'exited by F');
  await sleep(400);
  const out = await host.eval(GEOM);
  check('F exits', out.fullscreen === false);
  check('the control relabels back', out.btnLabel === 'fullscreen' && out.btnPressed === 'false');
  check('the idle flag is cleared on the way out', out.idle === null);
  check('windowed geometry is restored exactly',
    Math.abs(out.canvas.h - windowed.canvas.h) < 2, `${windowed.canvas.h} -> ${out.canvas.h}`);

  await host.holdKey(FKEY, 60);
  await host.waitFor('window.__retro.snapshot().fullscreen === true', 5000, 'F re-enters');
  check('F enters again', true);

  // The keymap claims plain letters, and so does this. The chat box must win.
  await host.eval('document.exitFullscreen()');
  await host.waitFor('window.__retro.snapshot().fullscreen === false', 5000, 'back on the page');
  await host.typeInto('#chat-input', 'af');
  await sleep(250);
  const typed = await host.eval('document.getElementById("chat-input").value');
  const toggled = await host.eval('window.__retro.snapshot().fullscreen');
  await host.eval('document.getElementById("chat-input").value = ""; document.getElementById("chat-input").blur()');
  check('F typed into the chat box types an f instead of toggling',
    typed === 'af' && toggled === false, `chat reads "${typed}", fullscreen=${toggled}`);

  // --- the clock survives both transitions ---------------------------------
  await host.clickSelector('#btn-fullscreen');
  await host.waitFor('window.__retro.snapshot().fullscreen === true', 5000, 'fullscreen again');
  await sleep(1200);
  const inside = await host.eval('window.__retro.machine().frame');
  await host.holdKey(FKEY, 60);
  await host.waitFor('window.__retro.snapshot().fullscreen === false', 5000, 'out again');
  await sleep(1000);
  const after = await host.eval('window.__retro.machine().frame');
  check('the emulator never stops across enter and exit',
    inside > beforeToggle && after > inside, `${beforeToggle} -> ${inside} -> ${after}`);

  // --- the game is still playable in there ---------------------------------
  await host.clickSelector('#btn-fullscreen');
  await host.waitFor('window.__retro.snapshot().fullscreen === true', 5000, 'fullscreen once more');
  await host.keyEvent('rawKeyDown', KEYS.RIGHT);
  const held = await host.eval('window.__retro.machine().latches[0].held');
  await host.keyEvent('keyUp', KEYS.RIGHT);
  check('game keys still reach the input latch in fullscreen',
    (held & bit('RIGHT')) !== 0, `held=0b${held.toString(2)}`);

  // --- leaving must not strand anyone in a black box -----------------------
  // The one synthetic click in this file, and deliberately so: LEAVE sits on the
  // page, and the whole point of fullscreen is that the page is not on screen,
  // so no trusted mouse event can reach it from here. Nothing on this path is
  // gated on user activation -- exitFullscreen() is not -- so a dispatched
  // click exercises exactly the code a person reaches by other means.
  await host.eval('document.getElementById("btn-leave").click()');
  await host.waitFor('document.fullscreenElement === null', 5000, 'released on leave');
  check('leaving the room drops out of fullscreen', true);
  check('and the control is hidden again with no picture',
    (await host.eval('document.getElementById("btn-fullscreen").hidden')) === true);

  const realErrors = host.errors.filter((e) => !/favicon/i.test(e));
  check('no uncaught page errors', realErrors.length === 0, realErrors.join(' | ') || 'clean');
} catch (err) {
  failure = err;
  console.error('\nverification aborted:', err.message);
} finally {
  conn.close();
  kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failure || failed.length) process.exit(1);
