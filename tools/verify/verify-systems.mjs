/**
 * Two emulators, one at a time.
 *
 * The claims under test, in the order a host meets them:
 *
 *   1. the host gets a dropdown, before the game and only before it;
 *   2. picking Neo Geo actually swaps the core — a different WASM module is
 *      fetched and the old one is thrown away, rather than both being held;
 *   3. a CPS zip dropped on the Neo Geo emulator is refused *by name*, with the
 *      sentence that names the emulator it does belong to;
 *   4. the host's choice reaches a guest, which brings up the same core;
 *   5. loading a game freezes the choice.
 *
 * What is deliberately not tested: that a Neo Geo game runs. This repository
 * ships no games and fetches none, and there is no Neo Geo romset here to point
 * at — so the core is verified to load, initialise and refuse the wrong file,
 * and running Metal Slug is left to somebody with Metal Slug.
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

/**
 * A tab with no dev-server game file, which is what every real host is.
 *
 * `__DEV_ROM_URL__` is baked in at build time, so the fetch is stubbed instead —
 * and it has to be installed before navigation, because navigating replaces the
 * realm. Getting this wrong is silent: the tab loads its file and boots straight
 * past the picker this check is entirely about.
 */
async function starvedTab(conn, label) {
  const tab = await Tab.create(conn, 'about:blank', label);
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
    tab.sessionId,
  );
  await tab.goto(APP);
  await tab.waitFor('typeof window.__retro === "object"', 60000, 'app boots');
  return tab;
}

/**
 * Drop files on the picker the way the browser would.
 *
 * DataTransfer is the only way to give a file input a value from script; a
 * `change` event on an empty input is not the same thing and would test nothing.
 */
async function dropFile(tab, name, bytes) {
  return tab.eval(`(async () => {
    const input = document.getElementById('rom-file');
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(${JSON.stringify(bytes)})], ${JSON.stringify(name)}));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

/** PK\\x03\\x04 and enough after it to look like an archive rather than a stub. */
const ZIP_BYTES = [0x50, 0x4b, 0x03, 0x04, ...new Array(60).fill(0)];

const { port, kill } = await launchChrome({ headless: true });
const conn = await connectBrowser(port);
console.log(`warming the dev server… ${await warmUp(conn, APP)}ms`);
let failure = null;

try {
  const host = await starvedTab(conn, 'HOST');
  await hostGame(host, { name: 'Ada', avatar: 'joystick' });
  await host.waitFor(
    'document.getElementById("rom-picker").hidden === false',
    120000,
    'host reaches the picker',
  );

  // --- 1. the choice exists, and only for the host -------------------------
  const options = await host.eval(
    '[...document.getElementById("rom-system").options].map((o) => o.value)',
  );
  check('the host is offered both emulators', options.join(',') === 'cps12,neogeo', options.join(', '));
  check(
    'and it defaults to CPS, which is what the room already ran',
    (await host.eval('document.getElementById("rom-system").value')) === 'cps12',
  );
  check(
    'the hint names games rather than board numbers',
    /Street Fighter II/.test(await host.eval('document.getElementById("rom-hint").textContent')),
    await host.eval('document.getElementById("rom-hint").textContent'),
  );
  check(
    'the choice is live while no game is loaded',
    (await host.eval('document.getElementById("rom-system").disabled')) === false,
  );

  // --- 2. picking Neo Geo swaps the core, rather than adding one -----------
  const before = await host.eval('window.__retro.snapshot().emulator?.system');
  check('the host booted exactly one core', before === 'cps12', `system=${before}`);

  await host.eval(`(() => {
    const select = document.getElementById('rom-system');
    select.value = 'neogeo';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const swapped = await host.waitFor(
    'window.__retro.snapshot().emulator?.system === "neogeo" && window.__retro.snapshot().emulator.system',
    120000,
    'the Neo Geo core comes up',
  );
  check('picking Neo Geo swaps the running core', swapped === 'neogeo');
  check(
    'the room says so too, not just the emulator',
    (await host.eval('window.__retro.snapshot().system')) === 'neogeo',
  );
  const hint = await host.eval('document.getElementById("rom-hint").textContent');
  check('the hint follows the choice', /Metal Slug/.test(hint) && /neogeo\.zip/.test(hint), hint);

  /*
   * Only one WASM module is ever fetched at a time. Both cores being requested
   * would still "work" — and would double what a player downloads — so this is
   * the check that keeps `import()` honest about being lazy.
   */
  const fetched = await host.eval(`
    performance.getEntriesByType('resource')
      .map((e) => e.name).filter((n) => n.endsWith('.wasm'))
      .map((n) => n.split('/').pop())
  `);
  check(
    'the second core was fetched only because the emulator changed',
    fetched.length === 2 && fetched.some((n) => n.includes('cps12')) && fetched.some((n) => n.includes('neogeo')),
    fetched.join(', '),
  );
  check(
    'and no core was downloaded twice',
    new Set(fetched).size === fetched.length,
    fetched.join(', '),
  );

  // --- 3. the wrong file is refused by name -------------------------------
  await dropFile(host, 'dino.zip', ZIP_BYTES);
  const wrongSystem = await host.waitFor(
    'document.getElementById("rom-error").textContent || null',
    10000,
    'the wrong-emulator error appears',
  );
  check(
    'a CPS game dropped on Neo Geo is named as a CPS game',
    /CPS-1 \/ CPS-2/.test(wrongSystem) && /Switch the emulator/.test(wrongSystem),
    wrongSystem,
  );
  check(
    'and it never reached the core',
    (await host.eval('window.__retro.snapshot().emulator?.romLoaded')) === false,
  );
  check(
    'the picker is still usable afterwards',
    (await host.eval('document.getElementById("rom-picker").hidden')) === false &&
      (await host.eval('document.getElementById("rom-system").disabled')) === false,
  );

  /*
   * A name neither core has is a different sentence: there is nothing to switch
   * to, the file simply has to keep its romset name.
   *
   * This is also the case that made the check a gate rather than a nicer error.
   * FBNeo's `retro_load_game` returns TRUE for a zip it has no driver for, then
   * reports 60.00Hz/48000Hz and emulates nothing — so `romLoaded` staying false
   * here is the whole point, not a detail.
   */
  await dropFile(host, 'Metal Slug (1996).zip', ZIP_BYTES);
  await sleep(400);
  const unknown = await host.eval('document.getElementById("rom-error").textContent');
  check(
    'a renamed file is told that the name is the driver',
    /no driver called/.test(unknown) && /filename/.test(unknown),
    unknown,
  );
  check(
    'and a name no core knows never reaches the core either',
    (await host.eval('window.__retro.snapshot().emulator?.romLoaded')) === false,
  );

  // Something that is not an archive at all is caught before either of those.
  await dropFile(host, 'sf2.zip', [0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
  await sleep(400);
  const notZip = await host.eval('document.getElementById("rom-error").textContent');
  check('a file that is not a zip says so', /not a zip archive/.test(notZip), notZip);

  /*
   * The name is right, so this one gets past the gate and reaches the core —
   * which is where FBNeo's other silence lives. A Neo Geo driver whose BIOS is
   * absent "loads" fine and reports the libretro defaults, so `isEmptyMachine`
   * is what turns 149 frames of black canvas into the sentence below. This is
   * the single most likely way to get a Neo Geo room wrong.
   */
  await dropFile(host, 'mslug.zip', ZIP_BYTES);
  const noBios = await host.waitFor(
    'document.getElementById("rom-error").textContent.includes("BIOS") && document.getElementById("rom-error").textContent',
    20000,
    'the missing-BIOS error appears',
  );
  check(
    'a Neo Geo game with no BIOS is told which file is missing',
    /neogeo\.zip/.test(noBios) && /alongside/.test(noBios),
    noBios,
  );
  check(
    'and the half-loaded core is thrown away rather than reused',
    (await host.eval('window.__retro.snapshot().emulator')) === null,
  );

  // --- 4. the choice reaches a guest --------------------------------------
  const roomCode = await host.eval('window.__retro.snapshot().roomCode');
  const guest = await starvedTab(conn, 'GUEST');
  await joinGame(guest, roomCode, { name: 'Bo', avatar: 'coin' });
  await guest.waitFor('window.__retro.snapshot().selfSlot === 2', 40000, 'guest seated');
  check(
    'the guest is told which emulator the room runs',
    (await guest.eval('window.__retro.snapshot().system')) === 'neogeo',
  );
  const guestCore = await guest.waitFor(
    'window.__retro.snapshot().emulator?.system === "neogeo" && "neogeo"',
    120000,
    'the guest brings up the same core',
  );
  check('and brings up that one, not the default', guestCore === 'neogeo');
  check(
    'a guest is offered no emulator choice — the host picks it',
    (await guest.eval('document.getElementById("rom-bar").hidden')) === true,
  );
  /*
   * A guest starts the default core as soon as it has a room and switches when
   * `welcome` names another, so one or two fetches are both correct depending
   * on which won the race. Downloading the *same* core twice is not — that was
   * the bug this check exists for.
   */
  const guestFetched = await guest.eval(`
    performance.getEntriesByType('resource')
      .map((e) => e.name).filter((n) => n.endsWith('.wasm')).map((n) => n.split('/').pop())
  `);
  check(
    'the guest downloaded each core at most once',
    new Set(guestFetched).size === guestFetched.length && guestFetched.length <= 2,
    guestFetched.join(', '),
  );

  // --- 5. loading a game freezes the choice -------------------------------
  await host.eval(`(() => {
    const select = document.getElementById('rom-system');
    select.value = 'cps12';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await host.waitFor(
    'window.__retro.snapshot().emulator?.system === "cps12"',
    120000,
    'back on the CPS core',
  );
  // The real file, through the real input, so this is the same path a player takes.
  const loaded = await host.eval(`(async () => {
    const bytes = await (await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/@fs${process.cwd()}/roms/dino.zip');
      xhr.responseType = 'blob';
      xhr.onload = () => resolve(xhr.response);
      xhr.onerror = () => reject(new Error('no dino.zip'));
      xhr.send();
    }));
    const input = document.getElementById('rom-file');
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dino.zip'));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })().catch((e) => String(e))`);
  check(
    'the host can load a real CPS romset after all that, on a rebuilt core',
    loaded === true,
    String(loaded),
  );

  await host.waitFor(
    'window.__retro.snapshot().emulator?.running === true',
    120000,
    'the game starts',
  );
  check(
    'the emulator is fixed once a game is loaded',
    (await host.eval('document.getElementById("rom-system").disabled')) === true,
  );
  const note = await host.eval('document.getElementById("rom-note").textContent');
  check('and the room says what it is playing on', /CPS-1 \/ CPS-2/.test(note), note);

  await host.screenshot(new URL('./shots/systems-host.png', import.meta.url).pathname);
  await guest.screenshot(new URL('./shots/systems-guest.png', import.meta.url).pathname);
  check(
    'no uncaught page errors',
    host.errors.length === 0 && guest.errors.length === 0,
    [...host.errors, ...guest.errors].join(' | ') || 'clean',
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
