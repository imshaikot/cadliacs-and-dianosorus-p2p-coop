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

const { port, kill } = await launchChrome({ headless: true });
const conn = await connectBrowser(port);
console.log(`warming the dev server… ${await warmUp(conn, APP)}ms`);
let failure = null;

try {
  const host = await Tab.create(conn, APP, 'HOST');
  const guest = await Tab.create(conn, APP, 'GUEST');

  // --- host claims a room code ---------------------------------------------
  await hostGame(host, { name: 'Ada', avatar: 'joystick' });
  const hostSnap = await host.waitFor(
    'window.__retro.snapshot().status === "ready" && window.__retro.snapshot()',
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
  await joinGame(guest, 'ZZZZ-ZZZZ-ZZZZ', { name: 'Bo', avatar: 'coin' });
  const badMsg = await guest.waitFor(
    '(() => { const t = document.getElementById("landing-error").textContent; return t ? t : false; })()',
    20000,
    'join failure message',
  );
  const badElapsed = Date.now() - badStart;
  check('bad room code is rejected', /no host is listening/i.test(badMsg), `"${badMsg}"`);
  check('bad room code fails fast (<10s)', badElapsed < 10000, `${badElapsed}ms`);

  // --- guest joins the real room -------------------------------------------
  await joinGame(guest, roomCode, { name: 'Bo', avatar: 'coin' });
  const guestSnap = await guest.waitFor(
    'window.__retro.snapshot().selfSlot !== null && window.__retro.snapshot()',
    25000,
    'guest welcomed',
  );
  check('guest reaches status=ready', guestSnap.status === 'ready', `selfId=${guestSnap.selfId}`);
  check('host assigned the guest player 2', guestSnap.selfSlot === 2);

  const hostAfterJoin = await host.waitFor(
    'window.__retro.snapshot().players.length === 2 && window.__retro.snapshot()',
    15000,
    'host sees 2 players',
  );
  check('host roster has 2 players', hostAfterJoin.players.length === 2,
    hostAfterJoin.players.map((p) => `P${p.slot}`).join(' '));

  // --- both consoles log an open connection --------------------------------
  const OPEN = /data channel open \(control\)/;
  check('host console logs an open connection', (await host.waitForConsole(OPEN)) !== null);
  check('guest console logs an open connection', (await guest.waitForConsole(OPEN)) !== null);

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
  const channels = await host.eval('window.__retro.channels()');
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
  // 0x7f is neither WireKind.Input (0x01) nor WireKind.StateChunk (0x02), so
  // the live netplay traffic now sharing this channel ignores it — and the
  // probe ignores netplay's packets in turn.
  const PROBE = [0x7f, 2, 3, 250, 255];
  await guest.eval(`window.__retroInputProbe = [];
    window.__retro.session().transport.onInput((from, bytes) => {
      if (bytes[0] === 0x7f) window.__retroInputProbe.push([...bytes]);
    });
    true`);
  await host.eval(`window.__retro.session().transport.sendInput(new Uint8Array(${JSON.stringify(PROBE)})); true`);
  const roundTripped = await guest.waitFor('window.__retroInputProbe.length > 0 && window.__retroInputProbe[0]', 10000, 'probe packet');
  check(
    "GOTCHA #2: serialization 'raw' round-trips a Uint8Array byte-for-byte",
    JSON.stringify(roundTripped) === JSON.stringify(PROBE),
    JSON.stringify(roundTripped),
  );
  const wireBytes = await host.eval(`(async () => {
    const pc = window.__retro.session().transport.describeChannels();
    return pc.length;
  })()`);
  check('describeChannels reports both channels per peer', wireBytes === 2, `${wireBytes} rows`);

  // --- gotcha #3: a squatted room code is regenerated, not fatal -----------
  const squatter = await Tab.create(conn, APP, 'SQUATTER');
  await squatter.eval(`window.__retro.forceHost(${JSON.stringify(roomCode)})`, { awaitPromise: false });
  const squatSnap = await squatter.waitFor(
    'window.__retro.snapshot().status === "ready" && window.__retro.snapshot()',
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
  const stats = await host.eval('window.__retro.stats()');
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
    'window.__retro.snapshot().players.length === 1 && window.__retro.snapshot()',
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
  kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failure || failed.length) process.exit(1);
