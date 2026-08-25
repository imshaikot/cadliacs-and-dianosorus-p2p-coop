import { generateRoomCode, normalizeRoomCode } from '@dino/shared';
import type { ChannelDiagnostics, PeerStats, PeerId } from '@dino/shared';

import { loadConfig } from './config.js';
import { Log } from './log.js';
import { Session } from './session.js';
import { UI } from './ui.js';

const config = loadConfig();
const log = new Log();

let session: Session | null = null;
let channelTimer: number | null = null;

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
  onLeave: () => teardown('left the room'),
  onChat: (text) => session?.sendChat(text),
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
  // Gotcha #1 evidence, printed as soon as the channels actually exist rather
  // than assumed from the PeerJS docs.
  startChannelWatch();
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

function teardown(reason: string): void {
  if (channelTimer !== null) {
    clearInterval(channelTimer);
    channelTimer = null;
  }
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
    logCount: log.entries.length,
  }),
};

if (import.meta.env.DEV) {
  window.__dino.forceHost = (code) => begin('host', code);
}
