/**
 * Handing a game file to a peer that has none.
 *
 * The host is given a file by the dev server; the guest is deliberately starved
 * of one, so the only way it can reach lockstep is if the host's copy actually
 * arrived over the mesh.
 *
 * The second half is the part that would be easy to get quietly wrong: a 4 MB
 * push in one go blocks the main thread and drops frames for the whole room. So
 * the host's frame clock is watched across the transfer, and it has to keep
 * advancing at close to full speed the entire time.
 */
import { mkdirSync } from 'node:fs';
import { launchChrome, connectBrowser, warmUp, Tab, sleep } from './cdp.mjs';
import { hostGame, joinGame } from './app.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5173/';
mkdirSync(new URL('./shots/', import.meta.url).pathname, { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const { port, kill } = await launchChrome({ headless: true });
const conn = await connectBrowser(port);
console.log(`warming the dev server… ${await warmUp(conn, APP)}ms`);
let failure = null;

try {
  const host = await Tab.create(conn, APP, 'HOST');
  await hostGame(host, { name: 'Ada', avatar: 'joystick' });
  const snap = await host.waitFor(
    'window.__retro.snapshot().emulator?.running && window.__retro.snapshot()',
    120000,
    'host is running its own game file',
  );
  check('the host has a game file of its own', snap.emulator.running === true);

  /*
   * Starve the guest. `__DEV_ROM_URL__` is baked in at build time, so the tab
   * cannot be told to skip it — but the dev-server fetch can be made to fail,
   * which is exactly the state a production guest is in.
   *
   * It has to be installed with addScriptToEvaluateOnNewDocument, not eval'd
   * into about:blank: navigating replaces the realm, so a stub written before
   * goto() is gone by the time the app's first line runs. Getting that wrong is
   * silent — the guest simply loads its own file and the check passes for the
   * wrong reason.
   */
  const guest = await Tab.create(conn, 'about:blank', 'GUEST');
  await conn.send(
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: `(() => {
        const real = window.fetch;
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url.includes('/roms/')) return Promise.reject(new Error('no game file here'));
          return real(input, init);
        };
      })()`,
    },
    guest.sessionId,
  );
  await guest.goto(APP);
  await guest.waitFor('typeof window.__retro === "object"', 60000, 'guest boots');
  check(
    'the guest really has no game file of its own',
    (await guest.eval('window.__retro.snapshot().emulator?.running')) !== true,
  );

  await joinGame(guest, snap.roomCode, { name: 'Bo', avatar: 'coin' });
  await guest.waitFor('window.__retro.snapshot().selfSlot === 2', 40000, 'guest seated');

  /*
   * Watch the host's clock *during* the send, sampled often enough to catch a
   * stall rather than average one away. An average over the whole transfer
   * would hide a 300ms freeze; the worst single window will not.
   */
  const samples = [];
  let running = false;
  const deadline = Date.now() + 90000;
  let last = { f: await host.eval('window.__retro.snapshot().emulator.frames'), t: Date.now() };
  while (Date.now() < deadline) {
    await sleep(100);
    const f = await host.eval('window.__retro.snapshot().emulator.frames');
    const t = Date.now();
    samples.push({ frames: f - last.f, ms: t - last.t });
    last = { f, t };
    if (await guest.eval('window.__retro.snapshot().emulator?.running === true')) {
      running = true;
      break;
    }
  }
  check('the guest never picked a file, yet is running one', running === true);

  const romLog = guest.console.find((c) => /game file received from a peer/.test(c.text));
  check('and it came from a peer', Boolean(romLog), romLog?.text ?? 'not logged');

  // Each sample spans ~100ms plus the round trip of the eval, so normalise.
  const rates = samples.filter((s) => s.ms > 50).map((s) => (s.frames / s.ms) * 1000);
  const worst = rates.length ? Math.min(...rates) : 0;
  check(
    'the host never stalled while sending',
    worst > 45,
    `worst ${worst.toFixed(1)} fps of ${rates.length} windows across the transfer`,
  );

  // --- and the two simulations agree ---------------------------------------
  await guest.waitFor('window.__retro.snapshot().netplay?.running === true', 120000, 'guest in lockstep');
  await host.waitFor('window.__retro.snapshot().netplay?.running === true', 60000, 'host in lockstep');
  await sleep(3000);
  const net = await host.eval('window.__retro.snapshot().netplay');
  check('two peers on a shared file reach lockstep', net.running === true, `frame ${net.frame}`);
  check('with no desyncs', (net.desyncs ?? 0) === 0, `desyncs=${net.desyncs}`);

  await host.screenshot(new URL('./shots/romshare-host.png', import.meta.url).pathname);
  await guest.screenshot(new URL('./shots/romshare-guest.png', import.meta.url).pathname);
  check('no uncaught page errors', host.errors.length === 0 && guest.errors.length === 0,
    [...host.errors, ...guest.errors].join(' | ') || 'clean');
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
