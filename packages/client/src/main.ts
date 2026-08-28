import { DEFAULT_CAPACITY, generateRoomCode, normalizeRoomCode } from '@retro/shared';
import type { ChannelDiagnostics, PeerStats, PeerId } from '@retro/shared';

import { loadConfig } from './config.js';
import { ControlsPanel } from './controls-panel.js';
import { LocalControls } from './emulator/controls.js';
import { Machine } from './emulator/machine.js';
import { loadRomFromDevServer, loadRomFromFile } from './emulator/rom.js';
import type { RomSource } from './emulator/rom.js';
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
  onRomPicked: (file) => {
    void loadRomFromFile(file)
      .then((rom) => startEmulation(rom))
      .catch((err) => {
        log.error('that file will not do', { message: err instanceof Error ? err.message : String(err) });
        ui.showStageMessage('That is not a zip archive. Pick your game\u2019s .zip file.');
        ui.showRomPicker(true);
      });
  },
});

ui.setBroker(config.brokerDescription);
log.onEntry((entry) => ui.appendLog(entry));
log.info('ready', { broker: config.brokerDescription, iceServers: config.broker.iceServers?.length ?? 'peerjs default' });

/**
 * Routes.
 *
 * A `#/join/CODE` link only *prefills* the field — it deliberately does not join
 * on its own. Gotcha #6 wants a real user gesture before anything starts, since
 * from M2 onward that gesture is what unblocks audio, and a link that opened a
 * microphone prompt on page load would be worse than one extra click.
 *
 * The room route exists so a refresh mid-game lands you back on the landing page
 * with the code already filled in, rather than on a blank one.
 */
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
  .on('/join/:code', ({ code }) => prefillFrom(code ?? ''))
  .on('/room/:code', ({ code }) => prefillFrom(code ?? ''))
  .otherwise(() => {});

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
    onReceived: (rom) => startEmulation(rom),
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
  // The URL now names the room, so a refresh or a shared tab lands somewhere
  // meaningful instead of on a bare landing page.
  router.navigate(`/room/${next.roomCode}`);
  ui.setBusy(false);

  // Every peer runs its own emulator; we synchronise inputs, not pixels.
  void bootEmulator();
  // Gotcha #1 evidence, printed as soon as the channels actually exist rather
  // than assumed from the PeerJS docs.
  startChannelWatch();
}

/**
 * Boot sequence, identical for every peer: WASM core first, then the ROM, then
 * the clock. Guests are not spectators — they simulate the same game.
 *
 * Audio needs a user gesture (gotcha #6). The HOST A GAME click is that
 * gesture, and it counts for the rest of the page's life — the browser's
 * "sticky activation" does not expire the way transient activation does — so
 * the awaits in here do not cost us the right to start an AudioContext.
 */
async function bootEmulator(): Promise<void> {
  if (machine) return;
  ui.showStageMessage('loading the emulator core…');
  try {
    machine = await Machine.boot({ canvas: ui.screen, onLog: onCoreLog });
  } catch (err) {
    log.error('the emulator core failed to load', {
      message: err instanceof Error ? err.message : String(err),
    });
    ui.showStageMessage('The emulator core failed to load. See the log.');
    return;
  }
  // Sample the gamepad on the emulator's clock rather than the display's.
  machine.onBeforeFrame = () => controls.poll();
  log.info('emulator core loaded');

  ui.showStageMessage('looking for a game…');
  const rom = await loadRomFromDevServer();
  if (rom) {
    startEmulation(rom);
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

function startEmulation(rom: RomSource): void {
  const m = machine;
  if (!m) return;
  ui.showRomPicker(false);
  ui.showStageMessage('starting…');
  try {
    m.loadRom(rom.name, rom.bytes);
  } catch (err) {
    log.error('the ROM would not load', {
      name: rom.name,
      bytes: rom.bytes.length,
      message: err instanceof Error ? err.message : String(err),
    });
    ui.showStageMessage('FBNeo rejected that ROM. See the log.');
    ui.showRomPicker(true);
    return;
  }
  log.info('game file loaded', { name: rom.name, bytes: rom.bytes.length, from: rom.origin });
  ui.setRomNote(rom.name, rom.origin);
  // Now we can answer anyone else who is stuck at the same point we were.
  void romShare?.setMine(rom);

  void m.start().then(
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
  const m = machine;
  machine = null;
  if (m) await m.dispose();
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
      ? { running: machine.running, targetFps: machine.core.fps, sampleRate: machine.core.sampleRate, ...machine.stats }
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
