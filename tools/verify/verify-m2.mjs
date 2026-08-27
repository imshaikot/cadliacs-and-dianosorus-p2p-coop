/**
 * M2' acceptance: every peer runs its own emulator, in lockstep, bit-identical.
 *
 * The architecture changed here — we no longer stream A/V from the host. Each
 * peer simulates the same game from its own ROM and we synchronise inputs. The
 * only acceptance criterion that really matters is therefore: at the same frame
 * number, do both peers have the same picture? Everything else is diagnostics.
 */
import { mkdirSync } from 'node:fs';
import { launchChrome, connectBrowser, warmUp, Tab, sleep } from './cdp.mjs';
import { hostGame, joinGame } from './app.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5173/';
const OUT = new URL('./shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Records (frame, checksum) every 10th frame, straight off the machine hook. */
const INSTALL_PROBE = `(() => {
  const m = window.__retro.machine();
  window.__syncProbe = [];
  m.frameAdvanced.on((frame) => {
    if (frame % 10 !== 0) return;
    const v = m.core.video();
    let h = 2166136261;
    for (let i = 0; i < v.pixels.length; i += 61) { h ^= v.pixels[i]; h = Math.imul(h, 16777619); }
    window.__syncProbe.push([frame, (h >>> 0).toString(16)]);
    if (window.__syncProbe.length > 800) window.__syncProbe.shift();
  });
  return true;
})()`;

const { port, kill } = await launchChrome({ headless: true });
const conn = await connectBrowser(port);
console.log(`warming the dev server… ${await warmUp(conn, APP)}ms`);
let failure = null;

try {
  const host = await Tab.create(conn, APP, 'HOST');
  await hostGame(host, { name: 'Ada', avatar: 'joystick' });
  const hostBoot = await host.waitFor(
    'window.__retro.snapshot().emulator?.running && window.__retro.snapshot()',
    120000,
    'host emulator running',
  );
  const roomCode = hostBoot.roomCode;
  check('host boots its own emulator', hostBoot.emulator.running === true, `frame ${hostBoot.emulator.frame}`);

  const guest = await Tab.create(conn, APP, 'GUEST');
  await joinGame(guest, roomCode, { name: 'Bo', avatar: 'coin' });

  const guestBoot = await guest.waitFor(
    'window.__retro.snapshot().emulator?.running && window.__retro.snapshot()',
    120000,
    'guest emulator running',
  );
  check('guest boots its OWN emulator, not a video feed', guestBoot.emulator.running === true);
  check('guest loaded its own ROM', guest.console.some((c) => /ROM loaded/.test(c.text)));
  check('guest was seated as player 2', guestBoot.selfSlot === 2, `slot ${guestBoot.selfSlot}`);

  // --- both reach lockstep -------------------------------------------------
  const hostNet = await host.waitFor(
    'window.__retro.snapshot().netplay?.running === true && window.__retro.snapshot().netplay',
    60000,
    'host in lockstep',
  );
  const guestNet = await guest.waitFor(
    'window.__retro.snapshot().netplay?.running === true && window.__retro.snapshot().netplay',
    60000,
    'guest in lockstep',
  );
  check('host reaches lockstep', hostNet.running === true, `ports ${hostNet.ports}, delay ${hostNet.delayFrames}f`);
  check('guest reaches lockstep', guestNet.running === true, `ports ${guestNet.ports}, delay ${guestNet.delayFrames}f`);
  check('both agree on the live port set', JSON.stringify(hostNet.ports) === JSON.stringify(guestNet.ports),
    `${JSON.stringify(hostNet.ports)} vs ${JSON.stringify(guestNet.ports)}`);
  check('host drives port 0, guest port 1', hostNet.selfPort === 0 && guestNet.selfPort === 1);
  check('guest restored the host savestate', guest.console.some((c) => /restored host state/.test(c.text)));

  // --- the only check that really matters ----------------------------------
  await host.eval(INSTALL_PROBE);
  await guest.eval(INSTALL_PROBE);
  await sleep(12000);

  const hp = await host.eval('window.__syncProbe');
  const gp = await guest.eval('window.__syncProbe');
  const gm = new Map(gp);
  const common = hp.filter(([f]) => gm.has(f));
  const mismatches = common.filter(([f, h]) => gm.get(f) !== h);
  check('peers sampled overlapping frames', common.length > 40, `${common.length} common frames of ${hp.length}/${gp.length}`);
  check(
    'IDENTICAL picture at identical frame numbers',
    common.length > 40 && mismatches.length === 0,
    mismatches.length
      ? `${mismatches.length}/${common.length} differed, first at frame ${mismatches[0][0]}`
      : `${common.length} frames compared, zero divergence`,
  );

  // --- both are actually advancing, not just frozen together ---------------
  const h1 = await host.eval('window.__retro.snapshot().emulator.frame');
  await sleep(3000);
  const h2 = await host.eval('window.__retro.snapshot().emulator.frame');
  const g2 = await guest.eval('window.__retro.snapshot().emulator.frame');
  const advancedFps = ((h2 - h1) * 1000) / 3000;
  check('lockstep still runs near full speed', advancedFps > 55, `${advancedFps.toFixed(1)} fps under lockstep`);
  check('peers stay within a few frames of each other', Math.abs(h2 - g2) < 20, `host ${h2}, guest ${g2}`);

  const hs = await host.eval('window.__retro.snapshot().netplay');
  check('stalls are rare', hs.stalls / (h2 || 1) < 0.25, `${hs.stalls} stalls over ${h2} frames`);
  console.log('\nhost netplay stats:', JSON.stringify(hs, null, 1));

  await host.screenshot(OUT + 'm2-host.png');
  await guest.screenshot(OUT + 'm2-guest.png');

  // --- a peer vanishing must not freeze everyone else ----------------------
  // This is the classic way a lockstep game dies: one peer goes, the rest wait
  // forever for input that is never coming. Killing the tab outright rather
  // than clicking "leave" is the harsher test — no goodbye is sent.
  const beforeDrop = await host.eval('window.__retro.snapshot().emulator.frame');
  const droppedAt = Date.now();
  await conn.send('Target.closeTarget', { targetId: guest.targetId });

  let recovered = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(250);
    const snap = await host.eval('window.__retro.snapshot()');
    if (snap.netplay && snap.netplay.phase === 'solo' && snap.emulator.frame > beforeDrop + 30) {
      recovered = { ms: Date.now() - droppedAt, frame: snap.emulator.frame, players: snap.players.length };
      break;
    }
  }
  check('host survives a peer vanishing and keeps running', recovered !== null,
    recovered ? `back to solo and advancing ${recovered.ms}ms after the tab died` : 'host never recovered — it is frozen');
  if (recovered) {
    check('recovery is prompt', recovered.ms < 12000, `${recovered.ms}ms`);
    check('roster drops the departed player', recovered.players === 1, `${recovered.players} player(s) left`);
  }

  const f1 = await host.eval('window.__retro.snapshot().emulator.frame');
  await sleep(2000);
  const f2 = await host.eval('window.__retro.snapshot().emulator.frame');
  check('host runs at full speed again after the drop', ((f2 - f1) * 1000) / 2000 > 55,
    `${(((f2 - f1) * 1000) / 2000).toFixed(1)} fps`);

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
