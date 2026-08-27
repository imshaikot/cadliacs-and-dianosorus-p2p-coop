/**
 * M1 acceptance, driven for real:
 *   the host page loads the FBNeo WASM core and the dev-server ROM, runs at full
 *   speed; attract mode renders; coin + start works; player 1 is
 *   keyboard-controllable.
 *
 * "Keyboard-controllable" is proven in two halves, because one alone is weak:
 *   - real CDP key events actually set bits in the input latch (DOM -> latch)
 *   - from an identical savestate, a run with input diverges from a run without
 *     (latch -> emulation). Deterministic, so it cannot pass by coincidence.
 */
import { mkdirSync } from 'node:fs';
import { launchChrome, connectBrowser, warmUp, Tab, sleep } from './cdp.mjs';
import { hostGame } from './app.mjs';
import { KEYS, bit } from './keys.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5173/';
const OUT = new URL('./shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Hash + non-black ratio of whatever is currently on the emulator canvas. */
const SCREEN_PROBE = `(() => {
  const c = document.getElementById('screen');
  const g = c.getContext('2d', { willReadFrequently: true });
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let h = 2166136261, nonBlack = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] | d[i+1] | d[i+2]) nonBlack++;
    h ^= d[i] + (d[i+1] << 3) + (d[i+2] << 6); h = Math.imul(h, 16777619);
  }
  return { hash: (h >>> 0).toString(16), nonBlackPct: nonBlack / (c.width * c.height) * 100, w: c.width, h: c.height };
})()`;

const { port, kill } = await launchChrome({ headless: true });
const conn = await connectBrowser(port);
console.log(`warming the dev server… ${await warmUp(conn, APP)}ms`);
let failure = null;

try {
  const host = await Tab.create(conn, APP, 'HOST');
  await hostGame(host, { name: 'Ada', avatar: 'joystick' });

  const boot = await host.waitFor(
    'window.__retro.snapshot().emulator?.running && window.__retro.snapshot()',
    120000,
    'emulator running',
  );
  const emu = boot.emulator;
  check('core boots and starts running', emu.running === true);
  check('core reports the CPS-1 refresh rate, not 60Hz', Math.abs(emu.targetFps - 59.63) < 0.01, `${emu.targetFps} Hz`);
  check('core reports its real audio rate', Math.abs(emu.sampleRate - 48002.15) < 0.5, `${emu.sampleRate} Hz`);

  const romLog = host.console.find((c) => /ROM loaded/.test(c.text));
  check('ROM came from roms/ via the dev server', /from: dev-server/.test(romLog?.text ?? ''), romLog?.text ?? 'not logged');
  check('FBNeo identified the romset', host.console.some((c) => /Romset description:/.test(c.text)));

  // --- runs at full speed --------------------------------------------------
  await sleep(1500); // let it settle past the boot spike
  const t1 = await host.eval('({ f: window.__retro.snapshot().emulator.frames, t: performance.now() })');
  await sleep(6000);
  const t2 = await host.eval('({ f: window.__retro.snapshot().emulator.frames, t: performance.now() })');
  const measuredFps = ((t2.f - t1.f) * 1000) / (t2.t - t1.t);
  const errPct = Math.abs(measuredFps - emu.targetFps) / emu.targetFps * 100;
  check('runs at full speed over a 6s window', errPct < 1.0,
    `${measuredFps.toFixed(3)} fps vs target ${emu.targetFps} (${errPct.toFixed(2)}% off)`);

  const mid = await host.eval('window.__retro.snapshot().emulator');
  check('frame cost leaves plenty of headroom', mid.frameTimeMs < 4,
    `${mid.frameTimeMs.toFixed(2)} ms of a ${(1000 / emu.targetFps).toFixed(2)} ms budget`);
  check('no catch-up frames were dropped', mid.droppedCatchUp === 0, String(mid.droppedCatchUp));

  // --- attract mode renders ------------------------------------------------
  const samples = [];
  for (let i = 0; i < 8; i += 1) {
    samples.push(await host.eval(SCREEN_PROBE));
    await sleep(700);
  }
  const s1 = samples[0];
  const distinct = new Set(samples.map((s) => s.hash));
  check('canvas is the native CPS-1 resolution', s1.w === 384 && s1.h === 224, `${s1.w}x${s1.h}`);
  check('attract mode renders real pixels', samples.every((s) => s.nonBlackPct > 5),
    `${s1.nonBlackPct.toFixed(1)}% non-black`);
  // CPS-1 attract mode holds some screens for 200+ frames, so a single short
  // window can legitimately see no change. Over 5.6s it must move.
  check('attract mode is animating', distinct.size >= 3,
    `${distinct.size} distinct frames across 8 samples over 5.6s`);
  await host.screenshot(OUT + 'm1-attract.png');

  // --- is the audio clock even real here? ----------------------------------
  const clock = await host.eval(`(async () => {
    const ctx = window.__retro.machine().audio.context;
    const a = { audio: ctx.currentTime, wall: performance.now() };
    await new Promise((r) => setTimeout(r, 3000));
    const b = { audio: ctx.currentTime, wall: performance.now() };
    return { ratio: (b.audio - a.audio) * 1000 / (b.wall - a.wall), rate: ctx.sampleRate, state: ctx.state };
  })()`);
  const clockRealtime = Math.abs(clock.ratio - 1) < 0.02;
  check('AudioContext is at the requested 48kHz', clock.rate === 48000, `${clock.rate} Hz, state=${clock.state}`);
  check('audio clock advances at wall-clock pace', clockRealtime,
    `${clock.ratio.toFixed(4)}x realtime — if this is not ~1.0, the headless null audio sink is not paced by hardware and every audio figure below is an artifact of that`);

  // --- audio is healthy ----------------------------------------------------
  const audio = mid.audio;
  check('audio buffer primed and sits near its target',
    audio.primed === true && Math.abs(audio.fill - 2400) < 700,
    `${audio.fill} samples (target 2400), primed=${audio.primed}`);

  const w1 = await host.eval('window.__retro.snapshot().emulator.audio');
  await sleep(5000);
  const w2 = await host.eval('window.__retro.snapshot().emulator.audio');
  const underrunsInWindow = w2.underruns - w1.underruns;
  const correctionsInWindow = w2.dropped - w1.dropped + (w2.repeated - w1.repeated);
  check('no underruns in steady state', underrunsInWindow === 0,
    `${underrunsInWindow} over 5s (${w2.underruns} since boot)`);
  check('drift steering is occasional, not constant', correctionsInWindow / 5 < 10,
    `${correctionsInWindow} corrections over 5s = ${(correctionsInWindow / 5).toFixed(1)}/s ` +
    `(expect ~2-3/s: the core produces 48002.15Hz into a 48000Hz sink)`);

  // --- real keys reach the input latch -------------------------------------
  await host.keyEvent('rawKeyDown', KEYS.COIN);
  const heldDown = await host.eval('window.__retro.machine().latches[0].held');
  await host.keyEvent('keyUp', KEYS.COIN);
  await sleep(50);
  const heldUp = await host.eval('window.__retro.machine().latches[0].held');
  check('a real keydown sets the COIN bit in the latch', (heldDown & bit('COIN')) !== 0, `held=0b${heldDown.toString(2)}`);
  check('and keyup clears it', (heldUp & bit('COIN')) === 0, `held=0b${heldUp.toString(2)}`);

  await host.keyEvent('rawKeyDown', KEYS.RIGHT);
  const heldRight = await host.eval('window.__retro.machine().latches[0].held');
  await host.keyEvent('keyUp', KEYS.RIGHT);
  check('and the joystick maps to RIGHT', (heldRight & bit('RIGHT')) !== 0, `held=0b${heldRight.toString(2)}`);

  // --- the chat box must still be typeable while the emulator holds the keys
  await host.typeInto('#chat-input', 'wasdzx15');
  const typed = await host.eval('document.getElementById("chat-input").value');
  await host.eval('document.getElementById("chat-input").value = ""; document.getElementById("chat-input").blur()');
  check('emulator keymap does not eat chat keystrokes', typed === 'wasdzx15', `typed "${typed}"`);

  // --- deterministic: input changes the emulation --------------------------
  const divergence = await host.eval(`(() => {
    const m = window.__retro.machine();
    m.stop();                                   // take the clock away from rAF
    const B = { COIN: 1 << 2, START: 1 << 3, RIGHT: 1 << 7 };
    const fnv = (px) => { let h = 2166136261; for (let i = 0; i < px.length; i += 7) { h ^= px[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
    const snap = () => fnv(m.core.video().pixels);
    const run = (frames, maskAt) => { for (let i = 0; i < frames; i++) { m.core.setInput(0, maskAt(i)); m.core.runFrame(); } return snap(); };

    // Get past attract mode first: coin, start, then let the game settle.
    const attract = m.core.serialize();
    const idleFromAttract = run(420, () => 0);
    m.core.unserialize(attract);
    const startedFromAttract = run(420, (i) => (i < 12 ? B.COIN : i < 24 ? B.START : 0));

    // Now branch from a common in-game state.
    const inGame = m.core.serialize();
    const a1 = run(150, () => 0);
    m.core.unserialize(inGame);
    const a2 = run(150, () => 0);           // identical input must replay identically
    m.core.unserialize(inGame);
    const withRight = run(150, () => B.RIGHT);
    m.core.unserialize(inGame);
    const withAttack = run(150, (i) => (i % 24 < 6 ? (1 << 0) : 0));

    return { stateBytes: inGame.length, idleFromAttract, startedFromAttract, a1, a2, withRight, withAttack };
  })()`);

  check('emulation is deterministic: same state + same input replays identically',
    divergence.a1 === divergence.a2, `${divergence.a1} == ${divergence.a2} (state ${divergence.stateBytes} B)`);
  check('COIN + START change the emulation', divergence.idleFromAttract !== divergence.startedFromAttract,
    `idle=${divergence.idleFromAttract} coin+start=${divergence.startedFromAttract}`);
  check('holding RIGHT diverges from idle', divergence.withRight !== divergence.a1,
    `idle=${divergence.a1} right=${divergence.withRight}`);
  check('tapping a button diverges from idle', divergence.withAttack !== divergence.a1,
    `idle=${divergence.a1} attack=${divergence.withAttack}`);

  // --- live, through the real keyboard, and photograph it ------------------
  await host.eval('window.__retro.machine().start()');
  await sleep(300);
  const beforeCoin = await host.eval(SCREEN_PROBE);
  await host.holdKey(KEYS.COIN, 150);
  await sleep(250);
  await host.holdKey(KEYS.START, 150);
  await sleep(2500);
  const afterStart = await host.eval(SCREEN_PROBE);
  check('live coin + start over real key events changed the screen', beforeCoin.hash !== afterStart.hash,
    `${beforeCoin.hash} -> ${afterStart.hash}`);
  await host.screenshot(OUT + 'm1-after-coin-start.png');

  await host.holdKey(KEYS.RIGHT, 1200);
  await sleep(400);
  await host.screenshot(OUT + 'm1-after-right.png');

  const final = await host.eval('window.__retro.snapshot().emulator');
  check('still running at the end', final.running === true, `${final.frames} frames`);
  check('the HUD resolves 59.63 from 60.00', Math.abs(final.emulatedFps - emu.targetFps) < 0.25,
    `HUD reads ${final.emulatedFps.toFixed(2)} fps`);

  const realErrors = host.errors.filter((e) => !/favicon/i.test(e));
  check('no uncaught page errors', realErrors.length === 0, realErrors.join(' | ') || 'clean');
  console.log('\nfinal emulator stats:', JSON.stringify(final, null, 1));
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
