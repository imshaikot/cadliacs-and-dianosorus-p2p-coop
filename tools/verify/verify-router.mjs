/**
 * The hash router.
 *
 * Shareable links are the one feature whose whole job happens before the app is
 * interesting, so nothing else in the suite would notice if it broke. The checks
 * that matter are the ones a person would hit: a link a friend pasted, a link
 * from before the router existed, and a link with a typo in it.
 */
import { mkdirSync } from 'node:fs';
import { launchChrome, connectBrowser, warmUp, Tab, sleep } from './cdp.mjs';
import { hostGame } from './app.mjs';

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

/** A tab that has finished booting, at whatever URL. */
async function open(name, url) {
  const tab = await Tab.create(conn, url, name);
  await tab.waitFor('typeof window.__retro === "object"', 60000, `${name} boots`);
  await sleep(400);
  return tab;
}

try {
  // --- a link a friend pasted ----------------------------------------------
  const hash = await open('HASH', `${APP}#/join/QG2C-0MHS-0EMM`);
  check(
    '#/join/:code prefills the code field',
    (await hash.eval('document.getElementById("input-code").value')) === 'QG2C-0MHS-0EMM',
  );
  // Deliberately does NOT auto-join: gotcha #6 wants a real gesture first.
  check(
    'and does not join on its own',
    (await hash.eval('window.__retro.snapshot().status')) !== 'ready',
    'a link that opened a microphone prompt on load would be worse than one click',
  );

  // --- a link from before the router ---------------------------------------
  const legacy = await open('LEGACY', `${APP}?join=QG2C0MHS0EMM`);
  check(
    'a legacy ?join= link is rewritten to a hash route',
    (await legacy.eval('location.hash')).startsWith('#/join/'),
    await legacy.eval('location.hash'),
  );
  check(
    'and still prefills the field',
    (await legacy.eval('document.getElementById("input-code").value')).length > 0,
  );

  // --- a link with a typo in it --------------------------------------------
  const bad = await open('BAD', `${APP}#/join/!!!`);
  const err = await bad.eval('document.getElementById("landing-error").textContent');
  check('a malformed code in a link is reported, not swallowed', /malformed/i.test(err), err);

  // --- the URL follows the room --------------------------------------------
  const room = await open('ROOM', APP);
  await hostGame(room, { name: 'Ada', avatar: 'joystick' });
  const snap = await room.waitFor(
    'window.__retro.snapshot().status === "ready" && window.__retro.snapshot()',
    30000,
    'host ready',
  );
  await sleep(300);
  check(
    'hosting routes to #/room/:code',
    (await room.eval('location.hash')) === `#/room/${snap.roomCode}`,
    await room.eval('location.hash'),
  );
  const share = await room.eval('document.getElementById("btn-copy").title');
  check('the copy button hands out that hash link', share.includes(`#/join/${snap.roomCode}`), share);

  await room.clickSelector('#btn-leave');
  await sleep(600);
  check('leaving the room returns to #/', (await room.eval('location.hash')) === '#/');

  check('no uncaught page errors', room.errors.length === 0, room.errors.join(' | ') || 'clean');
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
