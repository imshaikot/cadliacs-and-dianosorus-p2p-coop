/**
 * M6 acceptance: who you are, and being able to talk.
 *
 * Two things are being proved here, and the second is the one that is easy to
 * fake. Identity has to survive the mesh — P2 never hears from P3 directly
 * during the handshake, it learns about it from the host's roster — so the
 * check is that every peer names every other peer, not that the host does.
 *
 * Voice has to be *symmetric*. A one-way implementation (the shape this
 * codebase actually had, left over from the abandoned video design) passes
 * every mute-state check happily, because mute state travels on the control
 * channel and has nothing to do with audio. The assertion that catches it is
 * the last one: every peer must hold a live inbound audio track from each of
 * the other two.
 *
 * Chrome is launched with --use-fake-device-for-media-stream, so the microphone
 * is auto-granted and carries a synthetic tone. See cdp.mjs.
 */
import { mkdirSync } from 'node:fs';
import { launchChrome, connectBrowser, warmUp, Tab, sleep } from './cdp.mjs';
import { hostGame, joinGame, openIdentity, toggleMic } from './app.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5173/';
const MKEY = { code: 'KeyM', key: 'm', vk: 77 };
const OUT = new URL('./shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/**
 * What a peer's <audio> elements are actually receiving. `readyState` and a
 * live, unmuted track is the difference between "a MediaStream arrived" and
 * "audio is flowing".
 */
const INBOUND = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('#voice-sinks audio')) {
    const stream = el.srcObject;
    const tracks = stream ? stream.getAudioTracks() : [];
    out.push({
      peerId: el.dataset.peer,
      tracks: tracks.length,
      live: tracks.some((t) => t.readyState === 'live'),
      muted: el.muted,
    });
  }
  return out;
})()`;

/** Our own outbound track, which is what a mute toggle actually flips. */
const OUTBOUND = `(() => {
  const v = window.__retro.snapshot().voice;
  return { ...v };
})()`;

/**
 * Collect who a tab hears speaking over a window, rather than at one instant.
 *
 * Chrome's fake microphone emits a *pulsing* tone with silence between beeps,
 * so a single sample catches a gap as often as not. Real speech is continuous
 * enough for the 350ms hold in Voice; a test tone is not, so the honest
 * question here is "was this peer ever heard", not "is it audible right now".
 */
async function heardSpeaking(tab, ms = 8000) {
  const seen = new Set();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const id of await tab.eval('window.__retro.snapshot().voice.speaking')) seen.add(id);
    await sleep(120);
  }
  return seen;
}

const { port, kill } = await launchChrome({ headless: true });
const conn = await connectBrowser(port);
console.log(`warming the dev server… ${await warmUp(conn, APP)}ms`);
let failure = null;

try {
  // --- the name is mandatory ------------------------------------------------
  const gate = await Tab.create(conn, APP, 'GATE');
  await openIdentity(gate, 'host');
  const blankDisabled = await gate.eval('document.getElementById("btn-identity-go").disabled');
  check('a blank name will not let you in', blankDisabled === true);

  await gate.typeInto('#input-name', '   ');
  const spacesDisabled = await gate.eval('document.getElementById("btn-identity-go").disabled');
  check('a name of only spaces will not let you in either', spacesDisabled === true);

  await gate.typeInto('#input-name', 'Jack');
  const namedEnabled = await gate.eval('document.getElementById("btn-identity-go").disabled');
  check('a real name unlocks the button', namedEnabled === false);
  await gate.screenshot(OUT + 'm6-identity.png');
  await gate.clickSelector('#btn-identity-cancel');
  const closed = await gate.eval('document.getElementById("identity-modal").open');
  check('cancel backs out without joining', closed === false);
  await conn.send('Target.closeTarget', { targetId: gate.targetId });

  // --- three named players in one room --------------------------------------
  const host = await Tab.create(conn, APP, 'HOST');
  await hostGame(host, { name: 'Ada', avatar: 'joystick' });
  const boot = await host.waitFor(
    'window.__retro.snapshot().emulator?.running && window.__retro.snapshot()',
    120000,
    'host running',
  );
  const roomCode = boot.roomCode;

  const g1 = await Tab.create(conn, APP, 'GUEST1');
  // Deliberately over the 16-character limit: the clamp has to happen on the
  // way out AND be what the other peers see.
  await joinGame(g1, roomCode, { name: 'Bo the Long Named', avatar: 'coin' });
  await g1.waitFor('window.__retro.snapshot().netplay?.running === true', 120000, 'guest1 in lockstep');

  const g2 = await Tab.create(conn, APP, 'GUEST2');
  await joinGame(g2, roomCode, { name: 'Cy', avatar: 'cabinet' });
  await g2.waitFor('window.__retro.snapshot().netplay?.running === true', 120000, 'guest2 in lockstep');

  const tabs = { host, g1, g2 };
  for (const [n, t] of Object.entries(tabs)) {
    await t.waitFor('window.__retro.snapshot().players.length === 3', 60000, `${n} sees 3 players`);
  }

  const rosters = {
    host: await host.eval('window.__retro.snapshot().players'),
    g1: await g1.eval('window.__retro.snapshot().players'),
    g2: await g2.eval('window.__retro.snapshot().players'),
  };
  const describe = (players) => players.map((p) => `P${p.slot}:${p.label}/${p.avatar}`).join(' ');

  // The real test of the roster additions: a guest learns the *other* guest's
  // name and avatar only because the host passed them on.
  const expected = 'P1:Ada/joystick P2:Bo the Long Name/coin P3:Cy/cabinet';
  for (const [who, players] of Object.entries(rosters)) {
    check(`${who} sees all three names and avatars`, describe(players) === expected, describe(players));
  }
  // The field caps at 16 and the wire agrees with it; the point is that the two
  // do not disagree, since only one of them is enforceable on a remote peer.
  check(
    'an over-long name is capped at 16 characters, the same 16 on every peer',
    Object.values(rosters).every((ps) => ps.every((p) => p.label.length <= 16)) &&
      new Set(Object.values(rosters).map((ps) => ps.find((p) => p.slot === 2).label)).size === 1,
    describe(rosters.g2),
  );

  const rosterText = await host.eval('document.getElementById("roster").textContent');
  check('the names are on the page, not just in the model',
    /\bAda\b/.test(rosterText) && /\bCy\b/.test(rosterText), rosterText.replace(/\s+/g, ' ').slice(0, 140));
  const rosterAvatars = await host.eval(
    '[...document.querySelectorAll("#roster use")].map((u) => u.getAttribute("href")).join(",")',
  );
  check('each roster row draws an avatar', rosterAvatars.split(',').length === 3, rosterAvatars);

  // --- everyone joins muted -------------------------------------------------
  const voices = {
    host: await host.eval(OUTBOUND),
    g1: await g1.eval(OUTBOUND),
    g2: await g2.eval(OUTBOUND),
  };
  check('every peer may talk if it chooses to', Object.values(voices).every((v) => v.canTalk === true),
    Object.entries(voices).map(([k, v]) => `${k}:${v.micState}`).join(' '));
  check('every peer joins muted', Object.values(voices).every((v) => v.muted === true),
    Object.entries(voices).map(([k, v]) => `${k}:${v.muted}`).join(' '));
  // THE invariant behind the recording indicator: muted means no microphone is
  // held at all, not a track sitting there disabled.
  check('and holds no open microphone while muted',
    Object.values(voices).every((v) => v.liveTracks === 0),
    Object.entries(voices).map(([k, v]) => `${k}:${v.liveTracks} tracks`).join(' '));
  check('everyone sees everyone else as muted',
    Object.values(rosters).every((ps) => ps.every((p) => p.muted === true)));
  const micState = await host.eval('document.getElementById("btn-mic").dataset.state');
  check('the lobby control offers to unmute', micState === 'muted', micState);
  const micIcon = await host.eval(
    '!!document.querySelector("#btn-mic svg.mic-icon") && ' +
      'document.getElementById("btn-mic").textContent.trim() === ""',
  );
  check('and is an icon, not a word', micIcon === true);
  const orbOnPortrait = await host.eval(
    '!!document.querySelector("#roster li[data-self=\'true\'] .portrait > #btn-mic")',
  );
  check('and sits on the player’s own portrait', orbOnPortrait === true);
  const otherBadges = await host.eval(
    '[...document.querySelectorAll("#roster li[data-self=\'false\'] .portrait > .mic-badge")].length',
  );
  check('the other players show their status on theirs', otherBadges === 2, String(otherBadges));
  const lobbyCount = await host.eval('document.getElementById("lobby-count").textContent');
  check('the lobby says how many are in the room', /3 of 3/.test(lobbyCount), lobbyCount);

  // --- the calls stand up before anyone talks ------------------------------
  // Established with a silent placeholder, so every m-line is sendrecv and a
  // later unmute is a replaceTrack rather than a renegotiation PeerJS cannot do.
  for (const [n, t] of Object.entries(tabs)) {
    await t.waitFor(
      'window.__retro.snapshot().voice.calls.filter((c) => c.hasSender).length === 2',
      60000,
      `${n} has a send-capable call to both peers`,
    );
  }
  const ready = {
    host: await host.eval('window.__retro.snapshot().voice.calls'),
    g1: await g1.eval('window.__retro.snapshot().voice.calls'),
    g2: await g2.eval('window.__retro.snapshot().voice.calls'),
  };
  check('every pair negotiates a two-way call before anyone says anything',
    Object.values(ready).every((cs) => cs.length === 2 && cs.every((c) => c.hasSender)),
    Object.entries(ready).map(([k, cs]) => `${k}:${cs.map((c) => c.direction).join('/')}`).join(' '));
  check('and none of them is transmitting yet',
    Object.values(ready).every((cs) => cs.every((c) => c.senderTrack === null)),
    Object.entries(ready).map(([k, cs]) => `${k}:${cs.map((c) => c.senderTrack).join(',')}`).join(' '));
  check('nobody is shown as speaking in an empty room',
    (await host.eval('document.getElementById("speaking").hidden')) === true);

  // --- unmuting is seen by everyone ----------------------------------------
  const frameBefore = await host.eval('window.__retro.snapshot().emulator.frame');
  await toggleMic(g1);
  // Wait on the control the player actually sees, which only settles once the
  // microphone is genuinely open and the lobby has been redrawn from it.
  await g1.waitFor(
    'document.getElementById("btn-mic").getAttribute("aria-pressed") === "true"',
    15000,
    'g1 unmuted',
  );
  const g1Voice = await g1.eval(OUTBOUND);
  check('unmuting actually opens a microphone',
    g1Voice.muted === false && g1Voice.liveTracks === 1,
    `muted=${g1Voice.muted} liveTracks=${g1Voice.liveTracks}`);
  const pressed = await g1.eval('document.getElementById("btn-mic").getAttribute("aria-pressed")');
  check('the orb on the portrait reflects it', pressed === 'true', String(pressed));

  const P2SLOT = 'window.__retro.snapshot().players.find((p) => p.slot === 2)';
  for (const [n, t] of Object.entries({ host, g2 })) {
    await t.waitFor(`${P2SLOT}?.muted === false`, 15000, `${n} sees P2 unmute`);
  }
  const live = { host: await host.eval(P2SLOT), g2: await g2.eval(P2SLOT) };
  check('the other two both see P2 go live',
    Object.values(live).every((p) => p && p.muted === false && p.label === 'Bo the Long Name'),
    Object.entries(live).map(([k, p]) => `${k}:${p?.label}=${p?.muted}`).join(' '));

  // --- one talker, heard by everyone ---------------------------------------
  // Track liveness proves nothing now: the placeholder means everyone holds a
  // live inbound track from the moment they join. What proves audio is actually
  // crossing the wire is energy arriving at the far end, which is exactly what
  // the speaking detector measures.
  const sinks = { host: await host.eval(INBOUND), g1: await g1.eval(INBOUND), g2: await g2.eval(INBOUND) };
  check('every peer holds an inbound audio track from each of the other two',
    Object.values(sinks).every((peers) => peers.length === 2 && peers.every((p) => p.live)),
    Object.entries(sinks).map(([k, v]) => `${k}:${v.length}`).join(' '));

  const g1Id = await g1.eval('window.__retro.snapshot().selfId');
  const heardP2 = {
    host: await heardSpeaking(host),
    g2: await heardSpeaking(g2, 2000),
  };
  check('one player talking is heard by both the others, neither having unmuted',
    heardP2.host.has(g1Id) || heardP2.g2.has(g1Id),
    `host:[${[...heardP2.host].map((s) => s.slice(0, 8))}] g2:[${[...heardP2.g2].map((s) => s.slice(0, 8))}]`);

  // --- everyone talking, in every direction --------------------------------
  await toggleMic(host);
  await toggleMic(g2);
  for (const [n, t] of Object.entries(tabs)) {
    await t.waitFor(
      'document.getElementById("btn-mic").getAttribute("aria-pressed") === "true"',
      20000,
      `${n} unmuted`,
    );
  }

  // --- and the room is told who it is, over the picture ---------------------
  // Asserted as agreement between the model and the DOM, in one evaluation, and
  // not against a particular talker: Chrome's fake microphone emits a pulsing
  // tone that the sender's own noise suppression treats as noise, so *who* is
  // audible at any given instant is not something to pin a check on. That the
  // indicator always shows exactly the people the detector heard, is.
  const SPEAKING_DOM = `(() => {
    const snap = window.__retro.snapshot();
    const heard = new Set(snap.voice.speaking);
    const expected = snap.players
      .filter((p) => heard.has(p.isSelf ? 'self' : p.peerId))
      .map((p) => (p.isSelf ? 'you' : p.label));
    const bar = document.getElementById('speaking');
    return {
      expected,
      shown: [...bar.querySelectorAll('.talker b')].map((b) => b.textContent),
      hidden: bar.hidden,
      display: getComputedStyle(bar).display,
      lit: document.querySelectorAll('#roster li[data-speaking="true"]').length,
    };
  })()`;
  const speakingDom = await host.waitFor(
    `(() => { const d = ${SPEAKING_DOM}; return d.expected.length > 0 && d; })()`,
    30000,
    'host shows who is speaking',
  );
  check('the speaking indicator names exactly who is talking',
    JSON.stringify(speakingDom.shown) === JSON.stringify(speakingDom.expected) &&
      speakingDom.hidden === false,
    `shown=${JSON.stringify(speakingDom.shown)} expected=${JSON.stringify(speakingDom.expected)}`);
  check('the matching lobby cards light up too',
    speakingDom.lit === speakingDom.expected.length,
    `${speakingDom.lit} lit, ${speakingDom.expected.length} talking`);
  check('and it is actually displayed, not merely un-hidden',
    speakingDom.display === 'flex', speakingDom.display);
  // #stage-wrap is the element that goes fullscreen; being inside it is what
  // keeps the indicator on screen mid-game.
  const inStage = await host.eval('!!document.querySelector("#stage-wrap #speaking")');
  check('and lives inside the element that goes fullscreen', inStage === true);
  // The attribute has to really hide it as well, or it would sit over the game
  // permanently: an author `display` outranks the UA's `[hidden]` rule.
  const hiddenWorks = await host.eval(
    '(() => { const el = document.getElementById("speaking"); const was = el.hidden;' +
      ' el.hidden = true; const d = getComputedStyle(el).display; el.hidden = was; return d; })()',
  );
  check('and hides again when nobody is talking', hiddenWorks === 'none', hiddenWorks);

  const allLive = {
    host: await host.eval(OUTBOUND),
    g1: await g1.eval(OUTBOUND),
    g2: await g2.eval(OUTBOUND),
  };
  check('each has exactly one microphone open',
    Object.values(allLive).every((v) => v.liveTracks === 1),
    Object.entries(allLive).map(([k, v]) => `${k}:${v.liveTracks}`).join(' '));
  // This is the assertion a one-way implementation cannot pass: every peer is
  // transmitting to both of the others, on a sender that was there all along.
  const sending = {
    host: await host.eval('window.__retro.snapshot().voice.calls'),
    g1: await g1.eval('window.__retro.snapshot().voice.calls'),
    g2: await g2.eval('window.__retro.snapshot().voice.calls'),
  };
  for (const [who, calls] of Object.entries(sending)) {
    check(
      `${who} transmits to both of the other two, over the calls it already had`,
      calls.length === 2 && calls.every((c) => c.senderTrack === 'live' && c.hasSender),
      JSON.stringify(calls.map((c) => `${c.direction}:${c.senderTrack}`)),
    );
  }
  await host.screenshot(OUT + 'm6-lobby.png');

  // --- muting closes the device but keeps the call -------------------------
  await toggleMic(g1);
  const P2 = 'window.__retro.snapshot().players.find((p) => p.slot === 2)';
  for (const [n, t] of Object.entries({ host, g2 })) {
    await t.waitFor(`${P2}?.muted === true`, 15000, `${n} sees P2 mute again`);
  }
  const quiet = { host: await host.eval(P2), g2: await g2.eval(P2) };
  check('and see it go quiet again', Object.values(quiet).every((p) => p && p.muted === true),
    Object.entries(quiet).map(([k, p]) => `${k}:${p?.muted}`).join(' '));
  // The point of the whole design: muting again releases the device.
  const g1Closed = await g1.eval(OUTBOUND);
  check('muting closes the microphone rather than silencing it',
    g1Closed.liveTracks === 0, `liveTracks=${g1Closed.liveTracks}`);
  // ...and the call it was riding survived, so the next unmute is instant.
  // replaceTrack settles asynchronously, so this waits rather than samples.
  const g1Calls = await g1.waitFor(
    `(() => { const cs = window.__retro.snapshot().voice.calls;
       return cs.length === 2 && cs.every((c) => c.senderTrack === null) && cs; })()`,
    15000,
    'g1 stops transmitting',
  );
  check('the call survives a mute, so unmuting needs no new handshake',
    g1Calls.every((c) => c.open && c.hasSender && c.senderTrack === null),
    JSON.stringify(g1Calls.map((c) => `${c.open}/${c.direction}/${c.senderTrack}`)));

  // --- and none of it touched the game -------------------------------------
  await sleep(2000);
  const post = {
    host: await host.eval('window.__retro.snapshot().netplay'),
    g1: await g1.eval('window.__retro.snapshot().netplay'),
    g2: await g2.eval('window.__retro.snapshot().netplay'),
  };
  check('lockstep never stopped for any of it',
    Object.values(post).every((n) => n.running === true),
    Object.entries(post).map(([k, n]) => `${k}:${n.running}`).join(' '));
  check('no peer desynced while voice was connecting',
    Object.values(post).every((n) => n.desyncs === 0),
    Object.entries(post).map(([k, n]) => `${k}:${n.desyncs}`).join(' '));
  const frameAfter = await host.eval('window.__retro.snapshot().emulator.frame');
  check('the game kept running at full speed through it', frameAfter - frameBefore > 100,
    `${frameAfter - frameBefore} frames`);

  await host.screenshot(OUT + 'm6-room.png');

  // --- a peer leaving takes its audio with it -------------------------------
  await g1.clickSelector('#btn-leave');
  for (const [n, t] of Object.entries({ host, g2 })) {
    await t.waitFor(`(${INBOUND}).length === 1`, 30000, `${n} drops the departed peer's audio`);
  }
  const remaining = { host: await host.eval(INBOUND), g2: await g2.eval(INBOUND) };
  check('leaving takes that peer\u2019s audio element with it',
    Object.values(remaining).every((peers) => peers.length === 1),
    Object.entries(remaining).map(([k, v]) => `${k}:${v.length}`).join(' '));
  check('the peer who stayed is still audible',
    Object.values(remaining).every((peers) => peers.every((p) => p.live)),
    JSON.stringify(remaining.host));
} catch (err) {
  failure = err;
  console.error('\nharness error:', err.message);
} finally {
  kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failure || failed.length) {
  for (const c of failed) console.log(`  FAIL ${c.name}`);
  process.exit(1);
}
