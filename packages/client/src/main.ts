import { generateRoomCode, normalizeRoomCode } from '@dino/shared';
import type { ChannelDiagnostics, PeerStats, PeerId } from '@dino/shared';

import { loadConfig } from './config.js';
import { bindKeyboard } from './emulator/input.js';
import { Machine } from './emulator/machine.js';
import { loadRomFromDevServer, loadRomFromFile } from './emulator/rom.js';
import type { RomSource } from './emulator/rom.js';
import { Log } from './log.js';
import { Session } from './session.js';
import { UI } from './ui.js';

const config = loadConfig();
const log = new Log();

let session: Session | null = null;
let channelTimer: number | null = null;
let machine: Machine | null = null;
let hudTimer: number | null = null;
let unbindKeyboard: (() => void) | null = null;

const ui = new UI({
  onHost: () => void begin('host', generateRoomCode()),
  onJoin: (raw) => {
    const code = normalizeRoomCode(raw);
    if (!code) {
      ui.showError('That does not look like a room code. It is 12 characters.');
      return;
    }
    void begin('guest', code);
  },
  onLeave: () => void teardown('left the room'),
  onChat: (text) => session?.sendChat(text),
  onRomPicked: (file) => {
    void loadRomFromFile(file)
      .then((rom) => startEmulation(rom))
      .catch((err) => {
        log.error('that file will not do', { message: err instanceof Error ? err.message : String(err) });
        ui.showStageMessage('That is not a zip archive. Pick your dino.zip.');
        ui.showRomPicker(true);
      });
  },
});

ui.setBroker(config.brokerDescription);
log.onEntry((entry) => ui.appendLog(entry));
log.info('ready', { broker: config.brokerDescription, iceServers: config.broker.iceServers?.length ?? 'peerjs default' });

// A `?join=CODE` link only prefills the field. It deliberately does not join on
// its own: gotcha #6 wants a real user gesture before anything starts, because
// from M2 onward that gesture is what unblocks audio.
const prefill = new URLSearchParams(location.search).get('join');
if (prefill) {
  const code = normalizeRoomCode(prefill);
  if (code) {
    ui.prefillCode(code);
    log.info('room code prefilled from the URL, press JOIN to connect', { code });
  } else {
    ui.showError('The ?join= code in this link is malformed.');
  }
}

async function begin(role: 'host' | 'guest', roomCode: string): Promise<void> {
  if (session) return;
  ui.showError('');
  ui.setBusy(true);

  const label = role === 'host' ? 'host' : `guest-${Math.floor(Math.random() * 1000)}`;
  const next = new Session({ role, roomCode, broker: config.broker, label, log });
  session = next;

  next.roster.on((players) => ui.renderRoster(players));
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
    ui.showLanding();
    return;
  }

  ui.showRoom(role, next.roomCode);
  ui.setBusy(false);

  // Only the host runs an emulator. Guests get its output as video in M2.
  if (role === 'host') void bootEmulator();
  // Gotcha #1 evidence, printed as soon as the channels actually exist rather
  // than assumed from the PeerJS docs.
  startChannelWatch();
}

/**
 * Boot sequence for the host: WASM core first, then the ROM, then the clock.
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
  log.info('emulator core loaded');

  ui.showStageMessage('looking for the ROM…');
  const rom = await loadRomFromDevServer();
  if (!rom) {
    log.info('no ROM served by the dev server, asking for one');
    ui.showStageMessage('');
    ui.showRomPicker(true);
    return;
  }
  startEmulation(rom);
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
  log.info('ROM loaded', { name: rom.name, bytes: rom.bytes.length, from: rom.origin });

  void m.start().then(
    () => {
      ui.showScreen();
      // Port 0 is the host's own player 1. Ports 1 and 2 stay empty until M3
      // fills them from the network.
      unbindKeyboard = bindKeyboard(m.latches[0]!);
      log.info('emulator running', { fps: m.core.fps, sampleRate: m.core.sampleRate });
      startHud();
    },
    (err: unknown) => {
      log.error('the emulator would not start', {
        message: err instanceof Error ? err.message : String(err),
      });
      ui.showStageMessage('Could not start the emulator. See the log.');
    },
  );
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
  hudTimer = window.setInterval(() => {
    if (!machine) return;
    ui.renderHud(machine.stats, machine.core.fps);
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
  unbindKeyboard?.();
  unbindKeyboard = null;
  const m = machine;
  machine = null;
  if (m) await m.dispose();
  ui.hideHud();
  ui.showStageMessage('waiting');
  session?.close(reason);
  session = null;
  ui.renderChannels([]);
  ui.showLanding();
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
    __dino: {
      config: typeof config;
      logs: Log['entries'];
      session: () => Session | null;
      machine: () => Machine | null;
      channels: () => ChannelDiagnostics[];
      stats: () => Promise<Record<PeerId, PeerStats | null>>;
      snapshot: () => unknown;
      /** Dev only. Hosts on a specific room code instead of a random one, which
       *  is how the broker's ID-collision path gets exercised on purpose. */
      forceHost?: (code: string) => Promise<void>;
    };
  }
}

window.__dino = {
  config,
  logs: log.entries,
  session: () => session,
  machine: () => machine,
  channels: () => session?.describeChannels() ?? [],
  stats: async () => (await session?.peerStats()) ?? {},
  snapshot: () => ({
    role: session?.role ?? null,
    status: session?.status ?? 'idle',
    selfId: session?.selfId ?? null,
    selfSlot: session?.selfSlot ?? null,
    roomCode: session?.roomCode ?? null,
    prettyRoomCode: session?.prettyRoomCode ?? null,
    players: session?.players ?? [],
    channels: session?.describeChannels() ?? [],
    emulator: machine
      ? { running: machine.running, targetFps: machine.core.fps, sampleRate: machine.core.sampleRate, ...machine.stats }
      : null,
    logCount: log.entries.length,
  }),
};

if (import.meta.env.DEV) {
  window.__dino.forceHost = (code) => begin('host', code);
}
