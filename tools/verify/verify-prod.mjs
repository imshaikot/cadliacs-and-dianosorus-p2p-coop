/**
 * Production build smoke test.
 *
 * The dev server hands the app its ROM over Vite's `/@fs` route, which does not
 * exist in a built bundle — so every real user takes the file-picker path, and
 * until this ran, that path had never been executed once. Deploy notes written
 * without checking it would be guesswork.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { launchChrome, connectBrowser, warmUp, Tab, sleep } from './cdp.mjs';
import { hostGame, joinGame } from './app.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:4173/';
const ROM = process.env.ROM_PATH ?? '/Users/shahriar/Workspace/multi-deno/roms/dino.zip';
const OUT = new URL('./shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

if (!existsSync(ROM)) {
  console.error(`no ROM at ${ROM}`);
  process.exit(1);
}

const { port, kill } = await launchChrome({ headless: true });
const conn = await connectBrowser(port);
console.log(`warming… ${await warmUp(conn, APP)}ms`);
let failure = null;

async function bringUp(tab) {
  await tab.waitFor(
    '!document.getElementById("rom-picker").hidden',
    60000,
    'the ROM picker (production has no dev-server ROM)',
  );
  /*
   * Not just `!hidden`: production is the ONLY place this picker ever appears,
   * and setFileInput drives the input over CDP, which works perfectly on an
   * element no human could reach. That combination hid a real bug — a canvas
   * that was `hidden` in the DOM but still painting black over the whole stage,
   * because an author `display` beat the UA's `[hidden]` rule. So hit-test it:
   * ask the document what is actually at the centre of the file input.
   */
  const reachable = await tab.eval(`(() => {
    const input = document.getElementById('rom-file');
    const r = input.getBoundingClientRect();
    if (!r.width || !r.height) return 'the file input has no box';
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return input.contains(hit) || hit === input ? true : 'covered by ' +
      (hit ? (hit.id || hit.tagName) + '.' + (hit.className || '') : 'nothing');
  })()`);
  check(`${tab.name}: the ROM picker is actually clickable`, reachable === true,
    reachable === true ? '' : String(reachable));

  await tab.setFileInput('#rom-file', ROM);
  return tab.waitFor(
    'window.__retro.snapshot().emulator?.running && window.__retro.snapshot()',
    120000,
    'emulator running from the picked file',
  );
}

try {
  const host = await Tab.create(conn, APP, 'HOST');
  await hostGame(host, { name: 'Ada', avatar: 'joystick' });
  const boot = await bringUp(host);
  check('production build asks for a ROM instead of finding one', true);
  check('picked ROM boots the emulator', boot.emulator.running === true, `frame ${boot.emulator.frame}`);
  check('still the right refresh rate in a built bundle', Math.abs(boot.emulator.targetFps - 59.63) < 0.01);

  const t1 = await host.eval('window.__retro.snapshot().emulator.frames');
  await sleep(4000);
  const t2 = await host.eval('window.__retro.snapshot().emulator.frames');
  check('runs at full speed in production', ((t2 - t1) * 1000) / 4000 > 58,
    `${(((t2 - t1) * 1000) / 4000).toFixed(1)} fps`);

  // The debug hook is DEV-only; its absence proves the build really is a build.
  const hasDevHook = await host.eval('typeof window.__retro.forceHost === "function"');
  check('dev-only hooks are stripped from the bundle', hasDevHook === false);

  const guest = await Tab.create(conn, APP, 'GUEST');
  await joinGame(guest, boot.roomCode, { name: 'Bo', avatar: 'coin' });
  await bringUp(guest);
  await guest.waitFor('window.__retro.snapshot().netplay?.running === true', 90000, 'guest in lockstep');
  await host.waitFor('window.__retro.snapshot().netplay?.running === true', 60000, 'host in lockstep');
  check('two production peers reach lockstep', true);

  const probe = `(() => {
    const m = window.__retro.machine();
    window.__p = [];
    m.frameAdvanced.on((f) => {
      if (f % 10) return;
      const v = m.core.video();
      let h = 2166136261;
      for (let i = 0; i < v.pixels.length; i += 61) { h ^= v.pixels[i]; h = Math.imul(h, 16777619); }
      window.__p.push([f, (h >>> 0).toString(16)]);
      if (window.__p.length > 400) window.__p.shift();
    });
    return true;
  })()`;
  await host.eval(probe);
  await guest.eval(probe);
  await sleep(8000);
  const hp = await host.eval('window.__p');
  const gm = new Map(await guest.eval('window.__p'));
  const common = hp.filter(([f]) => gm.has(f));
  const bad = common.filter(([f, h]) => gm.get(f) !== h);
  check('production peers compute identical frames', common.length > 30 && bad.length === 0,
    `${common.length} frames compared, ${bad.length} differed`);

  await host.screenshot(OUT + 'prod-host.png');
  const errs = [...host.errors, ...guest.errors].filter((e) => !/favicon/i.test(e));
  check('no uncaught page errors', errs.length === 0, errs.join(' | ') || 'clean');
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
