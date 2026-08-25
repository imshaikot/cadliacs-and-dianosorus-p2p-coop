import type { BrokerConfig } from '@dino/shared';

/**
 * Every knob that decides *where* signalling happens lives here and comes from
 * the environment. Gotcha #4: the public PeerJS broker is rate limited and
 * periodically unreliable, so pointing at a self-hosted `npx peerjs` has to be
 * a config change and never a code change.
 *
 * With nothing set, PeerJS uses its own cloud defaults (0.peerjs.com:443/).
 */
export interface AppConfig {
  broker: BrokerConfig;
  /** Human-readable summary of where we are signalling, for the UI. */
  brokerDescription: string;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readNumber(value: unknown, name: string): number | undefined {
  const raw = readString(value);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[dino] ${name}="${raw}" is not a number, ignoring`);
    return undefined;
  }
  return n;
}

function readBoolean(value: unknown, name: string): boolean | undefined {
  const raw = readString(value)?.toLowerCase();
  if (raw === undefined) return undefined;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  console.warn(`[dino] ${name}="${raw}" is not a boolean, ignoring`);
  return undefined;
}

/**
 * Gotcha #12: PeerJS ships default STUN servers, which is enough for most home
 * networks but not for symmetric NAT. TURN credentials go here as JSON so a
 * provider can be swapped in without touching code.
 */
function readIceServers(value: unknown): RTCIceServer[] | undefined {
  const raw = readString(value);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    return parsed as RTCIceServer[];
  } catch (err) {
    console.warn('[dino] VITE_ICE_SERVERS is not valid JSON, falling back to PeerJS defaults:', err);
    return undefined;
  }
}

export function loadConfig(): AppConfig {
  const env = import.meta.env;
  const broker: BrokerConfig = {};

  const host = readString(env.VITE_PEER_HOST);
  const port = readNumber(env.VITE_PEER_PORT, 'VITE_PEER_PORT');
  const path = readString(env.VITE_PEER_PATH);
  const secure = readBoolean(env.VITE_PEER_SECURE, 'VITE_PEER_SECURE');
  const key = readString(env.VITE_PEER_KEY);
  const debugLevel = readNumber(env.VITE_PEER_DEBUG, 'VITE_PEER_DEBUG');
  const iceServers = readIceServers(env.VITE_ICE_SERVERS);

  if (host !== undefined) broker.host = host;
  if (port !== undefined) broker.port = port;
  if (path !== undefined) broker.path = path;
  if (secure !== undefined) broker.secure = secure;
  if (key !== undefined) broker.key = key;
  if (debugLevel !== undefined) broker.debugLevel = debugLevel;
  if (iceServers !== undefined) broker.iceServers = iceServers;

  const brokerDescription =
    host === undefined
      ? 'PeerJS cloud broker (default)'
      : `${secure === false ? 'ws' : 'wss'}://${host}:${port ?? (secure === false ? 80 : 443)}${path ?? '/'}`;

  return { broker, brokerDescription };
}
