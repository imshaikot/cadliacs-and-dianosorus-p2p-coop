/**
 * M0 acceptance, driven for real:
 *   tab A shows a room code, tab B enters it, both consoles log an open
 *   connection, and a string typed in A appears in B.
 *
 * Plus the gotchas that M0 is supposed to settle:
 *   #1 what the data channels actually negotiated
 *   #2 which PeerJS serialization key gives a raw Uint8Array
 *   #3 the unavailable-id -> regenerate path
 */
import { mkdirSync } from 'node:fs';
import { launchChrome, connectBrowser, Tab, sleep } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5173/';
const OUT = new URL('./shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const { proc } = await launchChrome({ port: 9222, headless: true });
const conn = await connectBrowser(9222);
let failure = null;

try {
  const host = await Tab.create(conn, APP, 'HOST');
  const guest = await Tab.create(conn, APP, 'GUEST');

  // --- host claims a room code ---------------------------------------------
  await host.clickSelector('#btn-host');
  const hostSnap = await host.waitFor(
    'window.__dino.snapshot().status === "ready" && window.__dino.snapshot()',
    25000,
    'host ready',
  );
  const roomCode = hostSnap.roomCode;
  check('host reaches status=ready', hostSnap.status === 'ready', `selfId=${hostSnap.selfId}`);
  check('host shows a 12-char room code', /^[0-9A-Z]{12}$/.test(roomCode ?? ''), `${hostSnap.prettyRoomCode}`);
  check('host is player 1', hostSnap.selfSlot === 1);

  const shownCode = await host.eval('document.getElementById("room-code").textContent');
  check('room code is on screen', shownCode === hostSnap.prettyRoomCode, shownCode);

  // --- a wrong code fails fast, not after the full timeout ------------------
  const badStart = Date.now();
  await guest.typeInto('#input-code', 'ZZZZ-ZZZZ-ZZZZ');
  await guest.clickSelector('#btn-join');
  const badMsg = await guest.waitFor(
    '(() => { const t = document.getElementById("landing-error").textContent; return t ? t : false; })()',
    20000,
    'join failure message',
  );
  const badElapsed = Date.now() - badStart;
  check('bad room code is rejected', /no host is listening/i.test(badMsg), `"${badMsg}"`);
  check('bad room code fails fast (<10s)', badElapsed < 10000, `${badElapsed}ms`);

  // --- guest joins the real room -------------------------------------------
  await guest.typeInto('#input-code', roomCode);
  await guest.clickSelector('#btn-join');
  const guestSnap = await guest.waitFor(
    'window.__dino.snapshot().selfSlot !== null && window.__dino.snapshot()',
    25000,
    'guest welcomed',
  );
  check('guest reaches status=ready', guestSnap.status === 'ready', `selfId=${guestSnap.selfId}`);
  check('host assigned the guest player 2', guestSnap.selfSlot === 2);

  const hostAfterJoin = await host.waitFor(
    'window.__dino.snapshot().players.length === 2 && window.__dino.snapshot()',
    15000,
    'host sees 2 players',
  );
  check('host roster has 2 players', hostAfterJoin.players.length === 2,
    hostAfterJoin.players.map((p) => `P${p.slot}`).join(' '));

  // --- both consoles log an open connection --------------------------------
  const hostOpenLog = host.console.some((c) => /data channel open \(control\)/.test(c.text));
  const guestOpenLog = guest.console.some((c) => /data channel open \(control\)/.test(c.text));
  check('host console logs an open connection', hostOpenLog);
  check('guest console logs an open connection', guestOpenLog);

  // --- a string typed in A appears in B ------------------------------------
  const phrase = 'ROOM FOR ONE MORE, JACK';
  await host.typeInto('#chat-input', phrase);
  await host.pressEnter();
  const gotOnGuest = await guest.waitFor(
    `[...document.querySelectorAll('#chat-log .text')].some(el => el.textContent === ${JSON.stringify(phrase)})`,
    15000,
    'phrase on guest',
  );
  check('string typed in the host tab appears in the guest tab', gotOnGuest === true, `"${phrase}"`);

  const reply = 'ready when you are';
  await guest.typeInto('#chat-input', reply);
  await guest.pressEnter();
  const gotOnHost = await host.waitFor(
    `[...document.querySelectorAll('#chat-log .text')].some(el => el.textContent === ${JSON.stringify(reply)})`,
    15000,
    'reply on host',
  );
  check('and the reply comes back the other way', gotOnHost === true, `"${reply}"`);

  // --- gotcha #1: what did the channels actually negotiate? ----------------
  const channels = await host.eval('window.__dino.channels()');
  const control = channels.find((c) => c.kind === 'control');
  const input = channels.find((c) => c.kind === 'input');
  console.log('\n--- negotiated data channels (host side) ---');
  console.table(channels.map(({ kind, label, readyState, requestedReliable, ordered, maxRetransmits, maxPacketLifeTime, binaryType }) =>
    ({ kind, label, readyState, requestedReliable, ordered, maxRetransmits, maxPacketLifeTime, binaryType })));
  check('control channel is open and ordered', control?.readyState === 'open' && control?.ordered === true);
  check('input channel is open and UNORDERED', input?.readyState === 'open' && input?.ordered === false);
  check(
    'GOTCHA #1: reliable:false does NOT set maxRetransmits',
    input?.maxRetransmits === null && input?.maxPacketLifeTime === null,
    `maxRetransmits=${input?.maxRetransmits} maxPacketLifeTime=${input?.maxPacketLifeTime} -> delivery is still fully reliable, only ordering was relaxed`,
  );

  // --- gotcha #2: raw Uint8Array round trip, and its overhead ---------------
  await guest.eval(`window.__dinoInputProbe = [];
    window.__dino.session().transport.onInput((from, bytes) => window.__dinoInputProbe.push([...bytes]));
    true`);
  await host.eval(`window.__dino.session().transport.sendInput(new Uint8Array([1,2,3,250,255])); true`);
  const roundTripped = await guest.waitFor('window.__dinoInputProbe.length > 0 && window.__dinoInputProbe[0]', 10000, 'input packet');
  check(
    "GOTCHA #2: serialization 'raw' round-trips a Uint8Array byte-for-byte",
    JSON.stringify(roundTripped) === JSON.stringify([1, 2, 3, 250, 255]),
    JSON.stringify(roundTripped),
  );
  const wireBytes = await host.eval(`(async () => {
    const pc = window.__dino.session().transport.describeChannels();
    return pc.length;
  })()`);
  check('describeChannels reports both channels per peer', wireBytes === 2, `${wireBytes} rows`);

  // --- gotcha #3: a squatted room code is regenerated, not fatal -----------
  const squatter = await Tab.create(conn, APP, 'SQUATTER');
  await squatter.eval(`window.__dino.forceHost(${JSON.stringify(roomCode)})`, { awaitPromise: false });
  const squatSnap = await squatter.waitFor(
    'window.__dino.snapshot().status === "ready" && window.__dino.snapshot()',
    30000,
    'squatter recovered',
  );
  check(
    'GOTCHA #3: a taken room code is rolled, not fatal',
    squatSnap.roomCode !== roomCode && /^[0-9A-Z]{12}$/.test(squatSnap.roomCode),
    `asked for ${roomCode}, ended up on ${squatSnap.roomCode}`,
  );
  const rolledWarning = squatter.console.some((c) => /already claimed on the broker/.test(c.text));
  check('and it says so in the log', rolledWarning);

  // --- RTT plumbing (M4 uses this, prove it reads today) -------------------
  const stats = await host.eval('window.__dino.stats()');
  const firstStat = Object.values(stats)[0];
  console.log('\n--- getStats() on the host->guest control connection ---');
  console.log(JSON.stringify(stats, null, 2));
  check('getPeerStats returns a candidate pair', !!firstStat && firstStat.localCandidateType !== null,
    firstStat ? `${firstStat.localCandidateType}/${firstStat.remoteCandidateType} rtt=${firstStat.rttMs}ms relayed=${firstStat.relayed}` : 'none');

  // Capture the connected state, where the channel table shows what actually
  // got negotiated.
  await sleep(700);
  await host.screenshot(OUT + 'm0-host-connected.png');
  await guest.screenshot(OUT + 'm0-guest-connected.png');

  // --- clean teardown ------------------------------------------------------
  await guest.clickSelector('#btn-leave');
  const hostAfterLeave = await host.waitFor(
    'window.__dino.snapshot().players.length === 1 && window.__dino.snapshot()',
    15000,
    'host sees the guest leave',
  );
  check('host notices the guest leaving', hostAfterLeave.players.length === 1);

  await sleep(400);
  await host.screenshot(OUT + 'm0-host.png');
  await guest.screenshot(OUT + 'm0-guest.png');

  // --- nothing exploded ----------------------------------------------------
  const realErrors = [...host.errors, ...guest.errors].filter((e) => !/favicon/i.test(e));
  check('no uncaught page errors', realErrors.length === 0, realErrors.join(' | ') || 'clean');

  console.log('\n--- host console ---\n' + host.consoleText());
  console.log('\n--- guest console ---\n' + guest.consoleText());
} catch (err) {
  failure = err;
  console.error('\nverification aborted:', err.message);
} finally {
  conn.close();
  proc.kill('SIGKILL');
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failure || failed.length) process.exit(1);
