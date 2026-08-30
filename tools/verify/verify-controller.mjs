/**
 * The controller dialog, driven by a controller.
 *
 * Chrome has no fake-gamepad flag the way it has one for cameras, and CDP has
 * no gamepad domain — so the device is stubbed at `navigator.getGamepads`,
 * which is the exact surface `LocalControls` reads and nothing deeper. The test
 * then moves sticks and presses buttons by writing to that stub, and everything
 * above it runs completely unmodified.
 *
 * What this is really here to prove is the arithmetic, because that is the part
 * that is invisible when it is wrong: a stick that rests at 0.30 must read zero
 * after centring, and one that only travels half must reach full scale after a
 * sweep. Both are checked against the corrected values the deadzone actually
 * compares, not against the numbers the dialog happens to print.
 */
import { mkdirSync } from 'node:fs';
import { launchChrome, connectBrowser, warmUp, Tab, sleep } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5173/';
mkdirSync(new URL('./shots/', import.meta.url).pathname, { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/**
 * A gamepad the test can move.
 *
 * Installed before navigation, because `LocalControls` reads the API from its
 * very first poll and a stub written afterwards would miss the pad-connected
 * path entirely.
 */
const FAKE_PAD = `(() => {
  window.__pad = {
    id: 'Test Pad (STANDARD GAMEPAD Vendor: 0000 Product: 0001)',
    mapping: 'standard',
    present: true,
    axes: [0, 0, 0, 0],
    buttons: new Array(17).fill(0),
  };
  navigator.getGamepads = () => {
    const p = window.__pad;
    if (!p || !p.present) return [];
    return [{
      index: 0,
      id: p.id,
      connected: true,
      mapping: p.mapping,
      axes: p.axes.slice(),
      buttons: p.buttons.map((v) => ({ pressed: v >= 0.5, touched: v > 0, value: v })),
      timestamp: performance.now(),
    }];
  };
})()`;

const { port, kill } = await launchChrome({ headless: true });
const conn = await connectBrowser(port);
console.log(`warming the dev server… ${await warmUp(conn, APP)}ms`);
let failure = null;

try {
  const tab = await Tab.create(conn, 'about:blank', 'PAD');
  await conn.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_PAD }, tab.sessionId);
  await tab.goto(APP);
  await tab.waitFor('typeof window.__retro === "object"', 60000, 'app boots');

  const axes = (values) => tab.eval(`(window.__pad.axes = ${JSON.stringify(values)}, true)`);
  const press = (index, down) =>
    tab.eval(`(window.__pad.buttons[${index}] = ${down ? 1 : 0}, true)`);
  const snap = () => tab.eval('window.__retro.snapshot().controls');
  const step = () => tab.eval('document.getElementById("pad-modal").dataset.step ?? null');

  // --- the pad arrives, without a room, a ROM or a clock -------------------
  const seen = await tab.waitFor(
    'window.__retro.snapshot().controls.padId || null',
    10000,
    'the pad is seen',
  );
  check('the pad is picked up on the landing page', /Test Pad/.test(seen), seen);
  check(
    'and is recognised as a standard layout',
    (await snap()).standard === true,
  );

  // --- the dialog opens from the panel ------------------------------------
  // The panel is a collapsed <details>, so the way in is the summary — clicked
  // for real, like everything else here, rather than toggled through the DOM.
  await tab.clickSelector('.controls-head');
  await tab.waitFor(
    'document.querySelector("#view-controls details").open === true',
    5000,
    'the controls panel expands',
  );
  await tab.clickSelector('#btn-pad-open');
  await tab.waitFor('document.getElementById("pad-modal").open === true', 5000, 'dialog opens');
  check('the controls panel opens the controller dialog', true);
  check('it starts as a tester, not a wizard', (await step()) === 'idle');

  // --- a press lights the picture but does not reach the game --------------
  await press(0, true);
  await sleep(150);
  const held = await snap();
  check(
    'a held button is tracked while the dialog is open',
    (await tab.eval('window.__retro.controls().isDown("btn:0")')) === true,
  );
  check(
    'but input is suspended, so sweeping a stick cannot drive the game',
    held.suspended === true && held.mask === 0,
    `suspended=${held.suspended} mask=${held.mask}`,
  );
  await press(0, false);

  // --- centring: a stick resting at 0.30 must come to read zero ------------
  await axes([0.3, -0.12, 0, 0]);
  await sleep(120);
  const drifting = await snap();
  check(
    'an uncalibrated resting stick reads as pushed',
    Math.abs(drifting.axes[0] - 0.3) < 0.02,
    `corrected[0]=${drifting.axes[0].toFixed(3)}`,
  );

  await tab.clickSelector('#btn-pad-primary');
  check('calibrate starts at the centring step', (await step()) === 'centre');
  // Centring ends on its own after its samples; the wizard notices and moves on.
  await tab.waitFor(
    'document.getElementById("pad-modal").dataset.step === "sweep"',
    15000,
    'centring completes and hands over to the sweep',
  );
  const centred = await snap();
  check(
    'after centring, the same resting stick reads zero',
    Math.abs(centred.axes[0]) < 0.02 && Math.abs(centred.axes[1]) < 0.02,
    `corrected=[${centred.axes[0].toFixed(3)}, ${centred.axes[1].toFixed(3)}] with raw still [0.3, -0.12]`,
  );

  // --- the sweep: half travel must come out as full scale ------------------
  // Rest is 0.30, so ±0.5 of real travel is 0.80 and -0.20 at the device.
  for (const value of [0.8, -0.2, 0.8, -0.2]) {
    await axes([value, -0.12, 0, 0]);
    await sleep(120);
  }
  await axes([0.3, -0.12, 0, 0]);
  await sleep(120);
  const sweeping = await snap();
  check(
    'the sweep reports the travel it has seen',
    sweeping.calibration?.phase === 'sweep' &&
      Math.abs((sweeping.calibration.travel[0]?.[1] ?? 0) - 0.5) < 0.02,
    JSON.stringify(sweeping.calibration?.travel?.[0] ?? null),
  );

  await tab.clickSelector('#btn-pad-primary');
  check('finishing the sweep moves on to the deadzone', (await step()) === 'deadzone');
  check('and the pad now counts as calibrated', (await snap()).calibrated === true);

  await axes([0.8, -0.12, 0, 0]);
  await sleep(120);
  const scaled = await snap();
  check(
    'a stick with half the travel now reaches full scale',
    Math.abs(scaled.axes[0] - 1) < 0.05,
    `raw 0.80 → corrected ${scaled.axes[0].toFixed(3)} (rest 0.30, travel 0.50)`,
  );

  // --- the deadzone suggestion comes from measured wobble ------------------
  const suggested = await snap();
  check(
    'a deadzone is suggested from the wobble it measured',
    typeof suggested.suggestedDeadzone === 'number' && suggested.restJitter !== null,
    `jitter=${suggested.restJitter} suggested=${suggested.suggestedDeadzone}`,
  );
  const before = (await snap()).deadzone;
  await tab.clickSelector('#btn-pad-suggest');
  await sleep(150);
  const applied = await snap();
  check(
    'and applying it actually changes the deadzone',
    applied.deadzone === suggested.suggestedDeadzone && applied.deadzone !== before,
    `${before} → ${applied.deadzone}`,
  );

  await tab.screenshot(new URL('./shots/controller-wizard.png', import.meta.url).pathname);
  await tab.clickSelector('#btn-pad-primary');
  check('finishing returns to the tester', (await step()) === 'idle');

  // --- closing gives the game its input back ------------------------------
  await axes([0, 0, 0, 0]);
  await tab.clickSelector('#btn-pad-close');
  await tab.waitFor('document.getElementById("pad-modal").open === false', 5000, 'dialog closes');
  await press(0, true);
  await sleep(150);
  const after = await snap();
  check(
    'closing restores input to the game',
    after.suspended === false && after.mask !== 0,
    `suspended=${after.suspended} mask=${after.mask}`,
  );
  await press(0, false);

  // --- clearing puts the raw readings back --------------------------------
  await tab.clickSelector('#btn-pad-open');
  await tab.waitFor('document.getElementById("pad-modal").open === true', 5000, 'dialog reopens');
  await tab.clickSelector('#btn-pad-secondary');
  await axes([0.3, -0.12, 0, 0]);
  await sleep(150);
  const cleared = await snap();
  check(
    'clearing calibration goes back to the raw readings',
    cleared.calibrated === false && Math.abs(cleared.axes[0] - 0.3) < 0.02,
    `corrected[0]=${cleared.axes[0].toFixed(3)}`,
  );

  // --- an unrecognised pad is not drawn as a pretend Xbox ------------------
  await tab.eval('(window.__pad.mapping = "", true)');
  await sleep(200);
  check(
    'a pad the browser cannot map is reported as unmapped, not faked',
    (await snap()).standard === false,
  );
  await tab.eval('(window.__pad.present = false, true)');
  await sleep(200);
  check('and unplugging it is noticed', (await snap()).padId === null);

  await tab.screenshot(new URL('./shots/controller-empty.png', import.meta.url).pathname);
  check(
    'no uncaught page errors',
    tab.errors.length === 0,
    tab.errors.join(' | ') || 'clean',
  );
} catch (err) {
  failure = err;
} finally {
  await kill();
}

if (failure) {
  console.error(`\n${failure.stack ?? failure}`);
  process.exit(1);
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
