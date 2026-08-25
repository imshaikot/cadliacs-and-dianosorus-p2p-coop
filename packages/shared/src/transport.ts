import type { Unsubscribe } from './emitter.js';
import type { ControlMessage } from './protocol.js';

export type { Unsubscribe };

export type PeerId = string;
export type TransportRole = 'host' | 'guest';

/**
 * The seam.
 *
 * Everything above this line is netcode-agnostic. V1 implements it with PeerJS
 * (see PeerJsTransport). V2's rollback netcode will almost certainly need raw
 * RTCPeerConnection so it can create a genuinely unreliable data channel
 * (`maxRetransmits: 0`), which PeerJS does not expose. When that happens, the
 * only file that changes is the adapter.
 *
 * Rule enforced by convention and by `npm run lint:layering`: no module outside
 * `peerjs-transport.ts` may import `peerjs`.
 */
export interface Transport {
  readonly role: TransportRole;
  /** Canonical room code. For a host this can differ from the requested one if
   *  the broker ID was already taken and we had to regenerate. */
  readonly roomCode: string;
  /** Our own broker ID. Null until `connect()` resolves. */
  readonly selfId: PeerId | null;

  /**
   * Host: register with the broker and start accepting guests.
   * Guest: dial the host and wait for its control channel to open.
   * Resolves once this peer is usable. Rejects on a fatal handshake failure.
   */
  connect(): Promise<ConnectResult>;

  /** Fires once per peer, when that peer's control channel opens. */
  onPeerJoin(cb: (peer: PeerInfo) => void): Unsubscribe;
  onPeerLeave(cb: (peerId: PeerId, reason: string) => void): Unsubscribe;

  /**
   * Fire-and-forget input frame. Never retransmitted at the application layer:
   * every packet is expected to carry its own last N frames of history, so a
   * drop self-heals ~16ms later. Silently no-ops if the input channel for a
   * peer is not open yet.
   *
   * Host: omit `to` to broadcast. Guest: `to` is ignored, it always goes to the
   * host.
   */
  sendInput(payload: Uint8Array, to?: PeerId): void;
  onInput(cb: (from: PeerId, payload: Uint8Array, receivedAt: number) => void): Unsubscribe;

  /** Reliable, ordered, low rate. Slot assignment, joins, goodbyes. */
  sendControl(msg: ControlMessage, to?: PeerId): void;
  onControl(cb: (from: PeerId, msg: ControlMessage) => void): Unsubscribe;

  /**
   * Host only. Sets the outbound A/V stream: it is offered to every currently
   * connected peer and to every peer that joins afterwards. Pass `to` to target
   * a single peer instead.
   */
  attachStream(stream: MediaStream, to?: PeerId): void;
  /** Guest only in practice: fires when the host's A/V stream arrives. */
  onStream(cb: (from: PeerId, stream: MediaStream) => void): Unsubscribe;

  onStatus(cb: (status: TransportStatus, detail: string) => void): Unsubscribe;
  onError(cb: (err: TransportError) => void): Unsubscribe;

  getPeers(): PeerInfo[];
  /** Per-peer transport health, read off RTCPeerConnection.getStats(). */
  getPeerStats(peerId: PeerId): Promise<PeerStats | null>;
  /** What the underlying data channels actually negotiated. See gotcha #1. */
  describeChannels(): ChannelDiagnostics[];

  /** Drop one peer without tearing down the whole transport. */
  disconnectPeer(peerId: PeerId, reason?: string): void;

  close(reason?: string): void;
}

export interface ConnectResult {
  selfId: PeerId;
  roomCode: string;
  /** True if the requested broker ID was taken and a new room code was rolled. */
  regenerated: boolean;
}

/**
 * Deliberately has no player slot on it. Which emulator port a peer drives is a
 * game concern negotiated over control messages, not a transport concern;
 * keeping it out is what lets the V2 rollback adapter be a drop-in.
 */
export interface PeerInfo {
  id: PeerId;
  label: string;
  joinedAt: number;
}

export type TransportStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'closed'
  | 'error';

export interface TransportError {
  /** PeerJS error type where there is one, otherwise our own code. */
  code: string;
  message: string;
  /** Fatal errors leave the transport unusable; the app must tear down. */
  fatal: boolean;
  peerId?: PeerId;
}

/** Everything the broker needs, all of it env-configurable. */
export interface BrokerConfig {
  /** Undefined means "use the PeerJS cloud broker defaults". */
  host?: string;
  port?: number;
  path?: string;
  secure?: boolean;
  key?: string;
  /** PeerJS log level, 0 = silent .. 3 = all. */
  debugLevel?: number;
  /**
   * ICE servers. PeerJS ships defaults (Google STUN). Symmetric NAT still needs
   * TURN, which has to be configured here.
   */
  iceServers?: RTCIceServer[];
}

export interface TransportOptions {
  role: TransportRole;
  /** Host: the code to claim. Guest: the code to dial. */
  roomCode: string;
  broker: BrokerConfig;
  /** Shown to the other peers. Cosmetic. */
  label?: string;
  /** How long to wait for the handshake before giving up. */
  connectTimeoutMs?: number;
}

/**
 * Snapshot of what a peer's data channels really negotiated, as opposed to what
 * we asked for. This exists because PeerJS's `reliable` flag does not map
 * one-to-one onto SCTP reliability, and we want the truth in the logs rather
 * than an assumption in a comment.
 */
export interface ChannelDiagnostics {
  peerId: PeerId;
  kind: 'control' | 'input';
  label: string;
  /** What we asked PeerJS for. */
  requestedReliable: boolean;
  requestedSerialization: string;
  readyState: RTCDataChannelState | 'missing';
  /** What the RTCDataChannel actually reports. */
  ordered: boolean | null;
  maxRetransmits: number | null;
  maxPacketLifeTime: number | null;
  negotiated: boolean | null;
  id: number | null;
  binaryType: string | null;
}

export interface PeerStats {
  peerId: PeerId;
  /** Selected candidate pair RTT, milliseconds. */
  rttMs: number | null;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  /** True when either end of the selected pair is a TURN relay. */
  relayed: boolean;
  availableOutgoingBitrateBps: number | null;
  bytesSent: number | null;
  bytesReceived: number | null;
}
