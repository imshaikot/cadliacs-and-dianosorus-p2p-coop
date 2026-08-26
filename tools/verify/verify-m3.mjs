/**
 * M3' acceptance: guest input drives player 2, on BOTH machines.
 *
 * The original milestone said "P2 moves in the host tab and in the guest's
 * video feed". There is no video feed any more — both peers simulate — so the
 * equivalent, and stricter, claim is: the guest's keypresses change the game on
 * both machines, and the two machines still agree frame for frame while it
 * happens. Input synchronised wrongly would show up instantly as divergence.
 */
import { mkdirSync } from 'node:fs';
import { launchChrome, connectBrowser, warmUp, Tab, sleep } from './cdp.mjs';
import { KEYS, bit } from './keys.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5173/';
const OUT = new URL('./shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const INSTALL_PROBE = `(() => {
  const m = window.__dino.machine();
  window.__syncProbe = [];
  m.frameAdvanced.on((frame) => {
    if (frame % 5 !== 0) return;
    const v = m.core.video();
    let h = 2166136261;
    for (let i = 0; i < v.pixels.length; i += 61) { h ^= v.pixels[i]; h = Math.imul(h, 16777619); }
    window.__syncProbe.push([frame, (h >>> 0).toString(16)]);
    if (window.__syncProbe.length > 2000) window.__syncProbe.shift();
  });
  return true;
})()`;

const SCREEN = `(() => {
  const c = document.getElementById('screen');
  const g = c.getContext('2d', { willReadFrequently: true });
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i += 4) { h ^= d[i] + (d[i+1] << 3) + (d[i+2] << 6); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
})()`;

/**
 * Compare the two peers AT THE SAME FRAME NUMBER.
 *
 * Comparing their canvases at the same wall-clock instant is not the same
 * question and gives the wrong answer: with an input delay of two frames the
 * peers sit one or two frames apart by design, so during active play their
 * screens legitimately differ at any given moment while the simulation is
 * perfectly in sync. Only frame-indexed comparison tests determinism.
 */
async function agreeAt(host, guest, minFrame, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hp = await host.eval('window.__syncProbe');
    const gp = await guest.eval('window.__syncProbe');
    const gm = new Map(gp);
    const shared = hp.filter(([f]) => f >= minFrame && gm.has(f));
    if (shared.length) {
      const [frame, hostHash] = shared[shared.length - 1];
      return { frame, hostHash, guestHash: gm.get(frame), agree: gm.get(frame) === hostHash };
    }
    if (Date.now() > deadline) return { frame: -1, agree: false, hostHash: null, guestHash: null };
    await sleep(250);
  }
}

function compare(hostProbe, guestProbe) {
  const gm = new Map(guestProbe);
  const common = hostProbe.filter(([f]) => gm.has(f));
  const bad = common.filter(([f, h]) => gm.get(f) !== h);
  return { common: common.length, bad };
}

const { port, kill } = await launchChrome({ headless: true });
const conn = await connectBrowser(port);
console.log(`warming the dev server… ${await warmUp(conn, APP)}ms`);
let failure = null;

try {
  const host = await Tab.create(conn, APP, 'HOST');
  await host.clickSelector('#btn-host');
  const boot = await host.waitFor(
    'window.__dino.snapshot().emulator?.running && window.__dino.snapshot()',
    120000,
    'host running',
  );

  const guest = await Tab.create(conn, APP, 'GUEST');
  await guest.typeInto('#input-code', boot.roomCode);
  await guest.clickSelector('#btn-join');
  await guest.waitFor('window.__dino.snapshot().netplay?.running === true', 120000, 'guest in lockstep');
  await host.waitFor('window.__dino.snapshot().netplay?.running === true', 60000, 'host in lockstep');
  check('both peers in lockstep', true);

  await host.eval(INSTALL_PROBE);
  await guest.eval(INSTALL_PROBE);
  await sleep(1500);

  // --- the guest's own keyboard must reach its own port -------------------
  await guest.keyEvent('rawKeyDown', KEYS.COIN);
  const guestHeld = await guest.eval('window.__dino.machine().latches[1].held');
  await guest.keyEvent('keyUp', KEYS.COIN);
  check('guest keyboard drives port 1, not port 0', (guestHeld & bit('COIN')) !== 0,
    `latch[1].held=0b${guestHeld.toString(2)}`);
  const guestPort0 = await guest.eval('window.__dino.machine().latches[0].held');
  check('guest does NOT touch player 1', guestPort0 === 0);

  // --- guest coins in; the host must see it -------------------------------
  const beforeHost = await host.eval(SCREEN);
  const beforeGuest = await guest.eval(SCREEN);
  check('screens match before the guest acts', beforeHost === beforeGuest, `${beforeHost}`);

  await guest.holdKey(KEYS.COIN, 200);
  await sleep(300);
  await guest.holdKey(KEYS.START, 200);
  await sleep(2500);

  const afterHost = await host.eval(SCREEN);
  check('the GUEST pressing coin+start changed the HOST screen', afterHost !== beforeHost,
    `${beforeHost} -> ${afterHost}`);
  const markA = await host.eval('window.__dino.machine().frame');
  const agreeA = await agreeAt(host, guest, markA);
  check('and both machines computed that frame identically', agreeA.agree,
    `frame ${agreeA.frame}: ${agreeA.hostHash} vs ${agreeA.guestHash}`);

  const hostPackets = await host.eval('window.__dino.snapshot().netplay.packetsIn');
  check('host is receiving the guest input stream', hostPackets > 100, `${hostPackets} packets in`);

  // --- both players acting at once, which is the real test ----------------
  await host.holdKey(KEYS.COIN, 200);
  await sleep(200);
  await host.holdKey(KEYS.START, 200);
  await sleep(1500);

  await host.keyEvent('rawKeyDown', KEYS.RIGHT);
  await guest.keyEvent('rawKeyDown', KEYS.LEFT);
  await sleep(1200);
  await host.keyEvent('rawKeyDown', KEYS.ATTACK);
  await guest.keyEvent('rawKeyDown', KEYS.JUMP);
  await sleep(1200);
  await host.keyEvent('keyUp', KEYS.RIGHT);
  await host.keyEvent('keyUp', KEYS.ATTACK);
  await guest.keyEvent('keyUp', KEYS.LEFT);
  await guest.keyEvent('keyUp', KEYS.JUMP);
  await sleep(1500);

  const bothHost = await host.eval(SCREEN);
  const markB = await host.eval('window.__dino.machine().frame');
  const agreeB = await agreeAt(host, guest, markB);
  check('simultaneous input from both players stays in sync', agreeB.agree,
    `frame ${agreeB.frame}: ${agreeB.hostHash} vs ${agreeB.guestHash}`);
  check('the screen actually moved while they played', bothHost !== afterHost);

  // --- the real proof: frame-for-frame agreement throughout ---------------
  const hp = await host.eval('window.__syncProbe');
  const gp = await guest.eval('window.__syncProbe');
  const { common, bad } = compare(hp, gp);
  // Sampled every 5th frame over a ~700 frame session, so ~140 is the ceiling.
  check('sampled plenty of shared frames', common > 80, `${common} common frames`);
  check(
    'ZERO divergence across the whole session, with both players acting',
    common > 80 && bad.length === 0,
    bad.length ? `${bad.length}/${common} differed, first at frame ${bad[0][0]}` : `${common} frames, identical`,
  );

  const net = await host.eval('window.__dino.snapshot().netplay');
  check('stalls stayed rare while playing', net.stalls < 60, `${net.stalls} stalls over ${net.frame} frames`);
  console.log('\nhost netplay:', JSON.stringify(net, null, 1));

  await host.screenshot(OUT + 'm3-host.png');
  await guest.screenshot(OUT + 'm3-guest.png');

  const realErrors = [...host.errors, ...guest.errors].filter((e) => !/favicon/i.test(e));
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
