/**
 * M4' acceptance: a third player, desync detection, and a HUD that reads
 * plausibly — plus the room lifecycle around all of it.
 *
 * The interesting part of a third player is not the third player; it is that
 * three peers need a full mesh. Routing P2's input to P3 through the host would
 * double the latency on the one thing that cannot afford it.
 */
import { mkdirSync } from 'node:fs';
import { launchChrome, connectBrowser, warmUp, Tab, sleep } from './cdp.mjs';
import { hostGame, joinGame } from './app.mjs';
import { KEYS } from './keys.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5173/';
const OUT = new URL('./shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const INSTALL_PROBE = `(() => {
  const m = window.__retro.machine();
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

async function joinRoom(conn, name, roomCode, player) {
  const tab = await Tab.create(conn, APP, name);
  await joinGame(tab, roomCode, player);
  return tab;
}

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
    'host running',
  );
  const roomCode = boot.roomCode;

  const g1 = await joinRoom(conn, 'GUEST1', roomCode, { name: 'Bo', avatar: 'coin' });
  await g1.waitFor('window.__retro.snapshot().netplay?.running === true', 120000, 'guest1 in lockstep');

  const g2 = await joinRoom(conn, 'GUEST2', roomCode, { name: 'Cy', avatar: 'cabinet' });
  await g2.waitFor('window.__retro.snapshot().netplay?.running === true', 120000, 'guest2 in lockstep');

  const tabs = { host, g1, g2 };
  for (const [n, t] of Object.entries(tabs)) {
    await t.waitFor('window.__retro.snapshot().netplay?.ports?.length === 3', 60000, `${n} sees 3 ports`);
  }
  const nets = {
    host: await host.eval('window.__retro.snapshot().netplay'),
    g1: await g1.eval('window.__retro.snapshot().netplay'),
    g2: await g2.eval('window.__retro.snapshot().netplay'),
  };
  check('all three peers reach lockstep with three ports',
    Object.values(nets).every((n) => JSON.stringify(n.ports) === '[0,1,2]'),
    Object.entries(nets).map(([k, n]) => `${k}:${JSON.stringify(n.ports)}`).join(' '));
  check('each peer drives a different port',
    new Set(Object.values(nets).map((n) => n.selfPort)).size === 3,
    Object.entries(nets).map(([k, n]) => `${k}=P${n.selfPort + 1}`).join(' '));

  // --- the mesh: guests must be wired to each other, not just to the host ---
  const peerCounts = {
    host: await host.eval('window.__retro.session().transport.getPeers().length'),
    g1: await g1.eval('window.__retro.session().transport.getPeers().length'),
    g2: await g2.eval('window.__retro.session().transport.getPeers().length'),
  };
  check('full mesh, not a star: every peer holds 2 connections',
    Object.values(peerCounts).every((c) => c === 2),
    JSON.stringify(peerCounts));

  // --- three independent players -------------------------------------------
  for (const t of Object.values(tabs)) await t.eval(INSTALL_PROBE);
  await sleep(1000);

  for (const t of Object.values(tabs)) {
    await t.holdKey(KEYS.COIN, 160);
    await sleep(200);
    await t.holdKey(KEYS.START, 160);
    await sleep(200);
  }
  await sleep(2500);

  // Each player does something different at the same time.
  await host.keyEvent('rawKeyDown', KEYS.RIGHT);
  await g1.keyEvent('rawKeyDown', KEYS.LEFT);
  await g2.keyEvent('rawKeyDown', KEYS.UP);
  await sleep(1500);
  await host.keyEvent('rawKeyDown', KEYS.ATTACK);
  await g2.keyEvent('rawKeyDown', KEYS.JUMP);
  await sleep(1500);
  await host.keyEvent('keyUp', KEYS.RIGHT);
  await host.keyEvent('keyUp', KEYS.ATTACK);
  await g1.keyEvent('keyUp', KEYS.LEFT);
  await g2.keyEvent('keyUp', KEYS.UP);
  await g2.keyEvent('keyUp', KEYS.JUMP);
  await sleep(2000);

  const latches = {
    host: await host.eval('window.__retro.machine().latches.map(l => l.held)'),
    g1: await g1.eval('window.__retro.machine().latches.map(l => l.held)'),
    g2: await g2.eval('window.__retro.machine().latches.map(l => l.held)'),
  };
  check('each peer only ever writes its own port',
    latches.host.filter((v) => v !== 0).length <= 1 &&
      latches.g1.filter((v) => v !== 0).length <= 1 &&
      latches.g2.filter((v) => v !== 0).length <= 1,
    JSON.stringify(latches));

  // --- all three simulations agree, frame for frame ------------------------
  const probes = {
    host: await host.eval('window.__syncProbe'),
    g1: await g1.eval('window.__syncProbe'),
    g2: await g2.eval('window.__syncProbe'),
  };
  const m1 = new Map(probes.g1);
  const m2 = new Map(probes.g2);
  const common = probes.host.filter(([f]) => m1.has(f) && m2.has(f));
  const bad = common.filter(([f, h]) => m1.get(f) !== h || m2.get(f) !== h);
  check('sampled plenty of frames all three share', common.length > 80, `${common.length} frames`);
  check('ALL THREE compute identical frames, with all three playing',
    common.length > 80 && bad.length === 0,
    bad.length ? `${bad.length}/${common.length} differed, first at frame ${bad[0][0]}` : `${common.length} frames, identical`);

  // --- desync detection is live and reporting zero -------------------------
  const post = {
    host: await host.eval('window.__retro.snapshot().netplay'),
    g1: await g1.eval('window.__retro.snapshot().netplay'),
    g2: await g2.eval('window.__retro.snapshot().netplay'),
  };
  check('the desync detector saw no desyncs',
    Object.values(post).every((n) => n.desyncs === 0),
    Object.entries(post).map(([k, n]) => `${k}:${n.desyncs}`).join(' '));

  // --- HUD reads plausibly -------------------------------------------------
  const hud = post.host;
  const rtts = Object.values(hud.rttByPort ?? {}).filter((v) => v != null);
  const jitters = Object.values(hud.jitterByPort ?? {});
  check('HUD has an RTT for each remote peer', rtts.length === 2, JSON.stringify(hud.rttByPort));
  check('HUD RTTs are plausible (0-500ms)', rtts.every((r) => r >= 0 && r < 500), JSON.stringify(rtts));
  check('HUD has arrival jitter per peer', jitters.length === 2, JSON.stringify(hud.jitterByPort));
  check('HUD jitter is plausible (<100ms on loopback)', jitters.every((j) => j >= 0 && j < 100), JSON.stringify(jitters));
  check('HUD input delay is in range', hud.delayFrames >= 2 && hud.delayFrames <= 12, `${hud.delayFrames} frames`);
  const hudText = await host.eval('document.getElementById("net-hud").textContent');
  check('HUD renders on the page', /lockstep/i.test(hudText) && /frame/.test(hudText), hudText.slice(0, 120));

  await host.screenshot(OUT + 'm4-host.png');
  await g2.screenshot(OUT + 'm4-guest3.png');

  // --- a fourth peer is turned away ----------------------------------------
  const g3 = await joinRoom(conn, 'GUEST4', roomCode, { name: 'Kirgo', avatar: 'skull' });
  const rejected = await g3.waitFor(
    '(() => { const t = document.getElementById("landing-error").textContent; return t ? t : false; })()',
    30000,
    'fourth peer rejected',
  );
  check('a fourth player is turned away, not silently broken', /full|reject/i.test(rejected), `"${rejected}"`);
  await conn.send('Target.closeTarget', { targetId: g3.targetId });

  // --- one player leaves cleanly -------------------------------------------
  await g1.clickSelector('#btn-leave');
  let after = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(250);
    const n = await host.eval('window.__retro.snapshot().netplay');
    if (n && n.ports.length === 2) { after = n; break; }
  }
  check('the room drops to two players when one leaves', after !== null,
    after ? `ports ${JSON.stringify(after.ports)}` : 'never dropped');
  const f1 = await host.eval('window.__retro.snapshot().emulator.frame');
  await sleep(2000);
  const f2 = await host.eval('window.__retro.snapshot().emulator.frame');
  check('the remaining two keep playing at full speed', ((f2 - f1) * 1000) / 2000 > 55,
    `${(((f2 - f1) * 1000) / 2000).toFixed(1)} fps`);

  // --- the host itself disappears ------------------------------------------
  await conn.send('Target.closeTarget', { targetId: host.targetId });
  let survivor = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    const snap = await g2.eval('window.__retro.snapshot()');
    if (snap.netplay && snap.netplay.phase === 'solo') { survivor = snap; break; }
  }
  check('a surviving peer keeps running when the HOST vanishes', survivor !== null,
    survivor ? `fell back to solo at frame ${survivor.emulator.frame}` : 'froze');
  if (survivor) {
    const s1 = await g2.eval('window.__retro.snapshot().emulator.frame');
    await sleep(2000);
    const s2 = await g2.eval('window.__retro.snapshot().emulator.frame');
    check('and it is still advancing afterwards', ((s2 - s1) * 1000) / 2000 > 55,
      `${(((s2 - s1) * 1000) / 2000).toFixed(1)} fps`);
  }

  const realErrors = g2.errors.filter((e) => !/favicon/i.test(e));
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
