/**
 * Room capacity.
 *
 * The interesting case is the one the type system cannot express: MAX_PLAYERS is
 * still 3 and the buffers are still sized for 3, so a two-player room is only
 * two players because the host refuses the third. That refusal is the check.
 */
import { mkdirSync } from 'node:fs';
import { launchChrome, connectBrowser, warmUp, Tab, sleep } from './cdp.mjs';
import { joinGame, openIdentity } from './app.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5173/';
mkdirSync(new URL('./shots/', import.meta.url).pathname, { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const text = (tab, id) => tab.eval(`document.getElementById(${JSON.stringify(id)}).textContent`);

const { port, kill } = await launchChrome({ headless: true });
const conn = await connectBrowser(port);
console.log(`warming the dev server… ${await warmUp(conn, APP)}ms`);
let failure = null;

try {
  const host = await Tab.create(conn, APP, 'HOST');
  await host.waitFor('typeof window.__retro === "object"', 60000, 'host boots');

  // --- only the host is asked ----------------------------------------------
  await openIdentity(host, 'guest', 'AAAA-BBBB-CCCC');
  check(
    'a guest is not asked how big the room is',
    await host.eval('document.getElementById("capacity-block").hidden'),
    'the host opened it; the guest is only told',
  );
  await host.clickSelector('#btn-identity-cancel');
  await sleep(200);
  await openIdentity(host, 'host');
  check('the host is', !(await host.eval('document.getElementById("capacity-block").hidden')));

  // --- open a two-player room ----------------------------------------------
  await host.typeInto('#input-name', 'Ada');
  await host.clickSelector('.capacity-pick[data-capacity="2"]');
  await host.clickSelector('#btn-identity-go');
  const snap = await host.waitFor(
    'window.__retro.snapshot().status === "ready" && window.__retro.snapshot()',
    30000,
    'host ready',
  );
  await sleep(400);
  check('the lobby counts to the chosen number', /of 2 players/.test(await text(host, 'lobby-count')),
    await text(host, 'lobby-count'));

  const g1 = await Tab.create(conn, APP, 'GUEST1');
  await joinGame(g1, snap.roomCode, { name: 'Bo', avatar: 'coin' });
  await g1.waitFor('window.__retro.snapshot().selfSlot === 2', 30000, 'guest1 seated');
  await sleep(600);
  check('a guest counts to the room size, not to MAX_PLAYERS',
    /of 2 players/.test(await text(g1, 'lobby-count')), await text(g1, 'lobby-count'));

  // --- and the third is turned away ----------------------------------------
  const g2 = await Tab.create(conn, APP, 'GUEST2');
  await joinGame(g2, snap.roomCode, { name: 'Cy', avatar: 'cabinet' });
  const reason = await g2.waitFor(
    '(document.getElementById("landing-error").textContent || "").length > 0 && document.getElementById("landing-error").textContent',
    30000,
    'guest2 is rejected',
  );
  check('a third player is refused by a two-player room', /full \(2 players\)/.test(reason), reason.trim());
  check('and the host still holds exactly two',
    (await host.eval('window.__retro.snapshot().players.length')) === 2);
  check('no uncaught page errors', host.errors.length === 0, host.errors.join(' | ') || 'clean');
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
