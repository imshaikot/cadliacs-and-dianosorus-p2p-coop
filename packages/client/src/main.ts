import { DEFAULT_CAPACITY, DEFAULT_SYSTEM, generateRoomCode, normalizeRoomCode } from '@retro/shared';
import type { ChannelDiagnostics, PeerStats, PeerId, SystemId } from '@retro/shared';

import { loadConfig } from './config.js';
import { ControlsPanel } from './controls-panel.js';
import { LocalControls } from './emulator/controls.js';
import { Machine } from './emulator/machine.js';
import { checkDriver, explainRefusal, loadRomFromDevServer, pickRom } from './emulator/rom.js';
import type { RomSource } from './emulator/rom.js';
import { systemInfo } from './emulator/systems.js';
import { Log } from './log.js';
import { Netplay } from './net/netplay.js';
import { RomShare } from './net/romshare.js';
import { Router } from './router.js';
import { Session } from './session.js';
import { UI } from './ui.js';
import type { Identity } from './ui.js';
import { Voice } from './voice.js';

const config = loadConfig();
const log = new Log();

let session: Session | null = null;
let channelTimer: number | null = null;
let machine: Machine | null = null;
let netplay: Netplay | null = null;
let romShare: RomShare | null = null;
let voice: Voice | null = null;
let hudTimer: number | null = null;
/** Guards the microphone toggle, which now has to await getUserMedia. */
let micBusy = false;
/**
 * Which core boot is the current one.
 *
 * The host can change its mind twice before the first six megabytes have
 * finished arriving, so every boot carries a token and a boot that finds itself
 * superseded throws its own machine away rather than installing it.
 */
let bootToken = 0;
/**
 * The boot in flight, so a second request for the same core joins it instead of
 * downloading six megabytes a second time. A guest hits this every join: it
 * starts the default core the moment it has a room, and the host's `welcome`
 * naming a different one lands a few milliseconds later.
 */
let booting: { system: SystemId; done: Promise<Machine | null> } | null = null;
/** One game gets loaded, once. Two sources race for it — see startEmulation. */
let romStarting = false;

// Physical controls outlive any one room: the profile, the gamepad poll and the
// on-screen legend are all page-scoped, and only the latch they feed changes
// when we join or leave.
const controls = new LocalControls();
const controlsPanel = new ControlsPanel(controls);

const ui = new UI({
  onHost: (identity) => void begin('host', generateRoomCode(), identity),
  onJoin: (raw, identity) => {
    const code = normalizeRoomCode(raw);
    if (!code) {
      ui.closeIdentity();
      ui.showError('That does not look like a room code. It is 12 characters.');
      return;
    }
    void begin('guest', code, identity);
  },
  onLeave: () => void teardown('left the room'),
  onToggleMic: () => void toggleMic(),
  onPeerAudible: (peerId, audible) => {
    voice?.setPeerAudible(peerId, audible);
    if (session) ui.renderRoster(session.players, (id) => voice?.isPeerAudible(id) ?? true);
  },
  onChat: (text) => session?.sendChat(text),
  onRomPicked: (files) => {
    // Guests have no file input, but a DOM is not an access control. The rule
    // is: the host picks the game, everyone else is sent the host's copy.
    if (session?.role === 'guest') {
      log.warn('guests cannot load their own game file, the host picks it');
      return;
    }
    const system = session?.system ?? DEFAULT_SYSTEM;
    void pickRom(files, system).then((pick) => {
      if (!pick.ok) {
        log.warn('that file will not do', { message: pick.message, system });
        ui.showRomError(pick.message);
        ui.showRomPicker(true);
        return;
      }
      ui.showRomError('');
      void startEmulation(pick.rom);
    });
  },
  onSystemPicked: (system) => chooseSystem(system),
});

ui.setBroker(config.brokerDescription);
log.onEntry((entry) => ui.appendLog(entry));
log.info('ready', { broker: config.brokerDescription, iceServers: config.broker.iceServers?.length ?? 'peerjs default' });

/**
 * Routes.
 *
 * A `#/join/CODE` link opens the join dialog with the code already applied, so
 * a guest lands one click from the room — but it deliberately does not join on
 * its own. Gotcha #6 wants a real user gesture before anything starts, since
 * from M2 onward that gesture is what unblocks audio, and a link that opened a
 * microphone prompt on page load would be worse than one click. Confirming the
 * dialog is that gesture.
 *
 * The room route exists so a refresh mid-game lands you back on the landing page
 * with the code already filled in, rather than on a blank one.
 */
function joinFrom(raw: string): void {
  const code = normalizeRoomCode(raw);
  if (code) {
    ui.openGuestJoin(code);
    log.info('join link opened, confirm the dialog to connect', { code });
  } else {
    ui.showError('The room code in that link is malformed.');
  }
}

function prefillFrom(raw: string): void {
  const code = normalizeRoomCode(raw);
  if (code) {
    ui.prefillCode(code);
    log.info('room code prefilled from the link, press JOIN to connect', { code });
  } else {
    ui.showError('The room code in that link is malformed.');
  }
}

const router = new Router()
  .on('/join/:code', ({ code }) => joinFrom(code ?? ''))
  .on('/room/:code', ({ code }) => prefillFrom(code ?? ''))
  // A session outranks the author page — see showAuthorView.
  .on('/author', () => ui.showAuthorView(true))
  .otherwise(() => ui.showAuthorView(false));

// Links from before the router used `?join=CODE`. Rewrite rather than drop them:
// somebody's chat history is not a good place to break a URL.
const legacy = new URLSearchParams(location.search).get('join');
if (legacy && !location.hash) router.navigate(`/join/${encodeURIComponent(legacy)}`);
router.start();

/**
 * Open or close the microphone, then tell the room.
 *
 * Unmuting has to go and fetch a track — a muted player holds no microphone at
 * all — so this is genuinely asynchronous and the control is held busy across
 * it. `Voice` may also refuse (a revoked permission, an unplugged device), so
 * what the room is told is what actually happened, read back afterwards.
 */
async function toggleMic(): Promise<void> {
  const s = session;
  const v = voice;
  if (!s || !v || !v.canTalk || micBusy) return;
  micBusy = true;
  ui.setMicBusy(true);
  try {
    await v.setMuted(!v.muted);
  } finally {
    micBusy = false;
    ui.setMicBusy(false);
  }
  s.setMuted(v.muted);
}

async function begin(role: 'host' | 'guest', roomCode: string, identity: Identity): Promise<void> {
  if (session) return;
  ui.showError('');
  ui.setBusy(true);

  // Settle the microphone permission before connecting — but do not hold a
  // microphone. Everyone joins muted, and muted here means no track exists at
  // all, so nothing is listening until someone chooses to talk. Saying no is a
  // fine answer too: that player hears everyone and is not heard.
  ui.showMicPending();
  const mic = await Voice.requestPermission(log);
  voice = mic;
  ui.closeIdentity();

  const next = new Session({
    role,
    roomCode,
    broker: config.broker,
    label: identity.name,
    avatar: identity.avatar,
    capacity: identity.capacity,
    log,
  });
  session = next;
  romShare = new RomShare(next.transport, log, {
    onReceived: (rom) => void startEmulation(rom),
    onProgress: (fraction, detail) => ui.showRomProgress(fraction, detail),
  });
  mic.attach(next.transport, ui.voiceSinks);
  mic.onSpeakingChange = (speaking) => ui.renderSpeaking(speaking);
  ui.setMicAvailable(mic.canTalk);

  next.roster.on((players) => {
    // A guest only learns the room's size from the host's `welcome`, which
    // lands before the first roster, so this is the earliest honest moment.
    ui.setCapacity(next.capacity);
    // Voice only measures peers the room says are unmuted; see setPeerMuted.
    for (const p of players) if (!p.isSelf) mic.setPeerMuted(p.peerId, p.muted);
    // Anyone who just arrived may be waiting on a file we already hold.
    romShare?.offerTo();
    ui.renderRoster(players, (id) => mic.isPeerAudible(id));
  });
  // Being refused is not an error state to sit in: go back to the landing page
  // and say why, rather than leaving someone staring at a room they are not in.
  next.rejected.on((reason) => {
    log.warn('the host turned us away', { reason });
    void teardown(`rejected: ${reason}`).then(() => ui.showError(`Could not join: ${reason}`));
  });
  next.chat.on((entry) => ui.appendChat(entry));
  next.statusChanged.on((status, detail) => ui.setStatus(status, detail));
  // Fires for the host's own pick and for a guest being told the host's. Both
  // ends do the same thing with it: show it, and bring up that core.
  next.systemChanged.on((system) => {
    ui.setSystem(system);
    void ensureEmulator();
  });

  try {
    await next.start();
  } catch (err) {
    log.error(`could not ${role === 'host' ? 'open' : 'join'} the room`, {
      message: err instanceof Error ? err.message : String(err),
    });
    ui.showError(explain(err, role));
    session = null;
    next.close('failed to connect');
    mic.dispose();
    voice = null;
    ui.showLanding();
    return;
  }

  if (!mic.canTalk) {
    log.warn('joined without a microphone, you will hear the others but not be heard', {
      state: mic.micState,
    });
  }

  ui.showRoom(role, next.roomCode);
  ui.setSystem(next.system);
  ui.lockSystem(role !== 'host');
  // The URL now names the room, so a refresh or a shared tab lands somewhere
  // meaningful instead of on a bare landing page.
  router.navigate(`/room/${next.roomCode}`);
  ui.setBusy(false);

  // Every peer runs its own emulator; we synchronise inputs, not pixels.
  void ensureEmulator();
  // Gotcha #1 evidence, printed as soon as the channels actually exist rather
  // than assumed from the PeerJS docs.
  startChannelWatch();
}

/**
 * Host only: change the room's emulator.
 *
 * The rule the whole feature hangs on is "before the game, not after" — every
 * peer has to be running the same core for lockstep to mean anything, and
 * swapping one out from under a live game would mean re-deriving a savestate
 * for hardware that never produced it. The control is disabled once a game
 * loads; this is the check behind that, because a disabled control is a
 * courtesy and not an enforcement.
 */
function chooseSystem(system: SystemId): void {
  const s = session;
  if (!s || s.role !== 'host' || s.system === system) return;
  if (machine?.core.loaded) {
    log.warn('the emulator is fixed once a game is loaded', { system: s.system });
    ui.setSystem(s.system);
    return;
  }
  ui.showRomError('');
  // Session broadcasts and emits; the emit is what actually swaps the core, so
  // the host and the guests take exactly the same path from here.
  s.setSystem(system);
}

/**
 * Bring up the core for `system`, replacing whatever is running.
 *
 * Only ever called with no game loaded, so "replacing" is never mid-frame.
 * The token guards the case that made this awkward: six megabytes take long
 * enough to fetch that a host can change its mind twice while the first one is
 * still in flight, and the loser must not install itself over the winner.
 */
async function useSystem(system: SystemId): Promise<Machine | null> {
  if (machine?.system === system) return machine;
  if (booting?.system === system) return booting.done;
  const done = bootSystem(system, (bootToken += 1));
  booting = { system, done };
  const result = await done;
  if (booting?.done === done) booting = null;
  return result;
}

/** Drop the running core, and make sure nothing in flight installs itself over it. */
async function discardMachine(): Promise<void> {
  bootToken += 1;
  booting = null;
  const m = machine;
  machine = null;
  if (m) await m.dispose();
}

async function bootSystem(system: SystemId, token: number): Promise<Machine | null> {
  const previous = machine;
  machine = null;
  if (previous) await previous.dispose();
  if (token !== bootToken) return null;

  const info = systemInfo(system);
  ui.showStageMessage(`loading the ${info.label} emulator…`);
  let next: Machine;
  try {
    next = await Machine.boot({ canvas: ui.screen, system, onLog: onCoreLog });
  } catch (err) {
    log.error('the emulator core failed to load', {
      system,
      message: err instanceof Error ? err.message : String(err),
    });
    ui.showStageMessage('The emulator core failed to load. See the log.');
    return null;
  }
  if (token !== bootToken) {
    // Somebody picked again while this one was downloading. Throw it away.
    await next.dispose();
    return null;
  }
  machine = next;
  // Sample the gamepad on the emulator's clock rather than the display's.
  next.onBeforeFrame = () => controls.poll();
  log.info('emulator core loaded', { system, label: info.label });
  return next;
}

/**
 * Boot sequence, identical for every peer: WASM core first, then the ROM, then
 * the clock. Guests are not spectators — they simulate the same game.
 *
 * Entered on joining a room and again every time the room's emulator changes,
 * so it has to be safe to re-enter. It is: `useSystem` is a no-op when the core
 * asked for is already the one running, and everything after it either finds a
 * game or settles into waiting for one, both of which are idempotent.
 *
 * Audio needs a user gesture (gotcha #6). The HOST A GAME click is that
 * gesture, and it counts for the rest of the page's life — the browser's
 * "sticky activation" does not expire the way transient activation does — so
 * the awaits in here do not cost us the right to start an AudioContext.
 */
async function ensureEmulator(): Promise<void> {
  const m = await useSystem(session?.system ?? DEFAULT_SYSTEM);
  // Null means this boot lost to a newer pick — a guest told the host's choice
  // while its default core was still downloading, typically. That pick's own
  // call is still running and owns everything below.
  if (!m || m.core.loaded) return;

  ui.showStageMessage('looking for a game…');
  const rom = await loadRomFromDevServer();
  if (rom) {
    await startEmulation(rom);
    return;
  }
  /*
   * Nobody handed us a file. Show the picker — but a peer may still offer one,
   * and RomShare asks for it the moment an offer arrives, so this is a fallback
   * rather than a dead end. Whichever lands first wins: a file the player picks,
   * or one a peer sends.
   */
  romShare?.request();
  log.info('no local game file, waiting for a peer to offer one or for a pick');
  ui.showStageMessage('');
  ui.showRomPicker(true);
}

/**
 * Load a game and start the clock.
 *
 * The romset carries the core it belongs to, so this is also the one place that
 * can find itself holding Neo Geo bytes on a CPS machine — a guest whose host
 * changed its mind, or the dev-server shortcut, where the filename decides.
 * Swapping first and loading second means there is exactly one code path for
 * "the right core is running", rather than a check at every caller.
 */
async function startEmulation(rom: RomSource): Promise<void> {
  if (romStarting || machine?.core.loaded) return;
  romStarting = true;
  try {
    const m = await useSystem(rom.system);
    if (!m) return;
    /*
     * The name gate again, for the origins that did not come through the
     * picker — a peer's copy, or the dev server's. FBNeo will happily "load" a
     * zip it has no driver for and then emulate nothing at a fictional 60Hz,
     * so this is the difference between a sentence and a black screen.
     */
    const wrong = checkDriver(rom.name, rom.system);
    if (wrong) {
      log.error('that game is not for this emulator', { name: rom.name, system: rom.system });
      ui.showRomError(wrong);
      ui.showRomPicker(true);
      return;
    }
    ui.showRomPicker(false);
    ui.showStageMessage('starting…');
    try {
      m.loadRom(rom);
    } catch (err) {
      log.error('the ROM would not load', {
        name: rom.name,
        bytes: rom.bytes.length,
        system: rom.system,
        message: err instanceof Error ? err.message : String(err),
      });
      // FBNeo's refusal is a bare zero, so the reason is reconstructed from
      // what we know about the name and the BIOS. See explainRefusal.
      ui.showRomError(explainRefusal(rom));
      ui.showRomPicker(true);
      /*
       * Throw the core away rather than let the next pick land on top.
       * `retro_load_game` half-succeeded — it wrote a romset into the FS and
       * left a machine behind — and there is no `retro_unload_game` exported to
       * undo that. A fresh instance is the only clean state, and it costs a
       * re-instantiation of an already-cached module, not another download.
       */
      await discardMachine();
      return;
    }
    log.info('game file loaded', {
      name: rom.name,
      bytes: rom.bytes.length,
      alongside: rom.extras.map((e) => e.name),
      system: rom.system,
      from: rom.origin,
    });
    // The core is settled for the life of the room from here.
    ui.lockSystem(true);
    ui.setRomNote(rom.name, rom.origin, rom.system);
    // Now we can answer anyone else who is stuck at the same point we were.
    void romShare?.setMine(rom);

    await m.start().then(
      async () => {
        ui.showScreen();
        log.info('emulator running', { fps: m.core.fps, sampleRate: m.core.sampleRate });
        startHud();
        await joinNetplay(m);
      },
      (err: unknown) => {
        log.error('the emulator would not start', {
          message: err instanceof Error ? err.message : String(err),
        });
        ui.showStageMessage('Could not start the emulator. See the log.');
      },
    );
  } finally {
    romStarting = false;
  }
}

/**
 * Bring this peer into the synchronised game.
 *
 * The keyboard is bound to OUR port, whichever that turns out to be — the host
 * drives port 0, guests get 1 and 2 — so the same code path serves every peer.
 */
async function joinNetplay(m: Machine): Promise<void> {
  const s = session;
  if (!s || netplay) return;
  let slot: number;
  try {
    slot = await s.waitForSlot();
  } catch (err) {
    log.error('never got a player slot, staying solo', {
      message: err instanceof Error ? err.message : String(err),
    });
    controls.attach(m.latches[0]!);
    controlsPanel.setSlot(1);
    return;
  }
  const port = slot - 1;
  controls.attach(m.latches[port]!);
  controlsPanel.setSlot(slot);
  log.info(`your controls drive player ${slot}`, { port, gamepad: controls.pad?.id ?? null });

  const net = new Netplay({
    session: s,
    machine: m,
    log,
    delayFramesOverride: config.inputDelayFrames,
    peerTimeoutMs: config.peerTimeoutMs,
  });
  netplay = net;
  net.onStatus((status) => ui.setNetStatus(status.phase, status.detail));
  net.attach();
  net.announceReady();
}

/** FBNeo is chatty on boot. Keep the page log readable; console keeps it all. */
function onCoreLog(line: string): void {
  const text = line.trimEnd();
  if (!text) return;
  console.debug('[fbneo]', text);
  if (/Romset description|successfully started|missing|error|failed/i.test(text)) {
    log.net(`fbneo: ${text}`);
  }
}

function startHud(): void {
  if (hudTimer !== null) return;
  let sinceLinkPoll = 0;
  hudTimer = window.setInterval(() => {
    if (!machine) return;
    const net = netplay;
    ui.renderHud(
      machine.stats,
      machine.core.fps,
      net?.lockstep.stats(machine.frame) ?? null,
      net ? { rttByPort: net.rttByPort, resyncs: net.resyncs } : null,
    );
    // getStats() is not cheap and its numbers barely move; once a second is plenty.
    sinceLinkPoll += 250;
    if (net && sinceLinkPoll >= 1000) {
      sinceLinkPoll = 0;
      void net.refreshLinkStats();
    }
  }, 250);
}

function startChannelWatch(): void {
  if (channelTimer !== null) return;
  const seen = new Set<string>();
  const tick = (): void => {
    const rows = session?.describeChannels() ?? [];
    ui.renderChannels(rows);
    for (const row of rows) {
      if (row.readyState !== 'open') continue;
      const key = `${row.peerId}:${row.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      log.net(`data channel open (${row.kind})`, negotiatedFacts(row));
    }
  };
  tick();
  channelTimer = window.setInterval(tick, 500);
}

/**
 * The exact question from gotcha #1: does PeerJS's `reliable: false` give a
 * genuinely unreliable channel, or only an unordered one?
 */
function negotiatedFacts(row: ChannelDiagnostics): Record<string, unknown> {
  const retransmitsCapped = row.maxRetransmits !== null || row.maxPacketLifeTime !== null;
  return {
    peerId: row.peerId,
    label: row.label,
    requestedReliable: row.requestedReliable,
    ordered: row.ordered,
    maxRetransmits: row.maxRetransmits,
    maxPacketLifeTime: row.maxPacketLifeTime,
    binaryType: row.binaryType,
    verdict: retransmitsCapped
      ? 'partially reliable (SCTP will give up on a lost packet)'
      : 'fully reliable delivery, retransmitted until it arrives',
  };
}

async function teardown(reason: string): Promise<void> {
  if (channelTimer !== null) {
    clearInterval(channelTimer);
    channelTimer = null;
  }
  if (hudTimer !== null) {
    clearInterval(hudTimer);
    hudTimer = null;
  }
  controls.attach(null);
  controlsPanel.setSlot(null);
  netplay?.detach();
  netplay = null;
  voice?.dispose();
  voice = null;
  romShare?.dispose();
  romShare = null;
  // Any core still downloading belongs to the room we are leaving.
  bootToken += 1;
  booting = null;
  romStarting = false;
  const m = machine;
  machine = null;
  if (m) await m.dispose();
  ui.lockSystem(false);
  ui.showRomError('');
  ui.hideHud();
  ui.showStageMessage('waiting');
  session?.close(reason);
  session = null;
  ui.renderChannels([]);
  ui.showLanding();
  router.navigate('/');
  log.info('left the room', { reason });
}

function explain(err: unknown, role: 'host' | 'guest'): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('peer-unavailable')) return 'No host is listening on that room code.';
  if (message.includes('connect-timeout')) return 'The host never answered. Wrong code, or they have gone.';
  if (message.includes('broker-timeout')) return 'The signalling broker did not respond. It may be rate limiting us.';
  if (message.includes('unavailable-id')) return 'Could not claim a room code on the broker. Try again.';
  return `Could not ${role === 'host' ? 'open' : 'join'} the room: ${message}`;
}

window.addEventListener('pagehide', () => session?.close('page closed'));

/**
 * Debug handle. Verification drives the real UI with real input events, then
 * reads ground truth from here instead of scraping the DOM.
 */
declare global {
  interface Window {
    __retro: {
      config: typeof config;
      logs: Log['entries'];
      session: () => Session | null;
      machine: () => Machine | null;
      controls: () => LocalControls;
      netplay: () => Netplay | null;
      voice: () => Voice | null;
      channels: () => ChannelDiagnostics[];
      stats: () => Promise<Record<PeerId, PeerStats | null>>;
      snapshot: () => unknown;
      /** Dev only. Hosts on a specific room code instead of a random one, which
       *  is how the broker's ID-collision path gets exercised on purpose. */
      forceHost?: (code: string) => Promise<void>;
    };
  }
}

window.__retro = {
  config,
  logs: log.entries,
  session: () => session,
  machine: () => machine,
  controls: () => controls,
  netplay: () => netplay,
  voice: () => voice,
  channels: () => session?.describeChannels() ?? [],
  stats: async () => (await session?.peerStats()) ?? {},
  snapshot: () => ({
    role: session?.role ?? null,
    status: session?.status ?? 'idle',
    selfId: session?.selfId ?? null,
    selfSlot: session?.selfSlot ?? null,
    roomCode: session?.roomCode ?? null,
    prettyRoomCode: session?.prettyRoomCode ?? null,
    system: session?.system ?? null,
    fullscreen: ui.fullscreen,
    players: session?.players ?? [],
    voice: voice
      ? {
          micState: voice.micState,
          canTalk: voice.canTalk,
          muted: voice.muted,
          // Zero whenever muted. This is what the recording indicator reports.
          liveTracks: voice.liveTracks,
          peers: voice.peers,
          speaking: [...voice.speaking],
          calls: session?.describeVoice() ?? [],
        }
      : null,
    channels: session?.describeChannels() ?? [],
    emulator: machine
      ? {
          system: machine.system,
          romLoaded: machine.core.loaded,
          running: machine.running,
          targetFps: machine.core.fps,
          sampleRate: machine.core.sampleRate,
          ...machine.stats,
        }
      : null,
    netplay: netplay && machine
      ? {
          ...netplay.status,
          ...netplay.lockstep.stats(machine.frame),
          resyncs: netplay.resyncs,
          rttByPort: netplay.rttByPort,
        }
      : null,
    logCount: log.entries.length,
  }),
};

if (import.meta.env.DEV) {
  // Bypasses the identity dialog on purpose: this exists to exercise the
  // broker's ID-collision path, and typing a name into a modal is not part of
  // what it is testing.
  window.__retro.forceHost = (code) =>
    begin('host', code, { name: 'squatter', avatar: 'skull', capacity: DEFAULT_CAPACITY });
}
