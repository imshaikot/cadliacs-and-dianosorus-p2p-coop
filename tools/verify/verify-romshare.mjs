/**
 * Handing a game file to a peer that has none.
 *
 * The host is given a file by the dev server; the guest is deliberately starved
 * of one, so the only way it can reach lockstep is if the host's copy actually
 * arrived over the mesh.
 *
 * The second half watches the host's frame clock across the transfer. It is a
 * regression guard rather than a proof that the sender's pacing is required —
 * see the note where it is measured.
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
   * Watch the host's clock during the send.
   *
   * Sampling fps over the transfer from out here does not work: it is over in a
   * couple of hundred milliseconds, so there are only two or three samples, and
   * the guest is booting a 6 MB core on the same machine at the same moment —
   * the number that comes back measures CPU contention, not this code.
   *
   * The longest gap between two frames does work as a measurement. Be clear on
   * what it establishes, though: removing the pacing entirely still passes this,
   * because 256 sends are simply not enough to block the thread. It is a
   * regression guard on the clock, not evidence that the pacing is doing work at
   * this file size. See the note in romshare.ts.
   */
  await host.eval(`(() => {
    const m = window.__retro.machine();
    window.__gap = { max: 0, last: performance.now(), frames: 0 };
    m.frameAdvanced.on(() => {
      const now = performance.now();
      window.__gap.max = Math.max(window.__gap.max, now - window.__gap.last);
      window.__gap.last = now;
      window.__gap.frames += 1;
    });
    return true;
  })()`);

  const running = await guest.waitFor(
    'window.__retro.snapshot().emulator?.running === true',
    90000,
    'guest boots the game file it was sent',
  );
  check('the guest never picked a file, yet is running one', running === true);

  const romLog = guest.console.find((c) => /game file received from a peer/.test(c.text));
  check('and it came from a peer', Boolean(romLog), romLog?.text ?? 'not logged');

  const gap = await host.eval('window.__gap');
  check(
    'the host clock keeps running through the transfer',
    gap.max < 150 && gap.frames > 5,
    `longest gap between frames ${gap.max.toFixed(0)}ms over ${gap.frames} frames (one frame is 16.8ms)`,
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
