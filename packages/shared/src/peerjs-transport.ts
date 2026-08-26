/**
 * ============================================================================
 * THE ONLY FILE IN THIS REPO THAT IS ALLOWED TO IMPORT `peerjs`.
 * ============================================================================
 *
 * Everything else talks to the `Transport` interface. When V2 replaces this
 * with raw RTCPeerConnection (for a genuinely unreliable input channel), this
 * file is the diff.
 *
 * Two data channels per peer, both opened by the guest:
 *
 *   dino-ctl   reliable: true,  serialization 'json'  -> ordered, retransmitted
 *   dino-in    reliable: false, serialization 'raw'   -> UNORDERED, still retransmitted
 *
 * On that second one: PeerJS builds the channel as
 *   `peerConnection.createDataChannel(label, { ordered: !!options.reliable })`
 * and sets neither `maxRetransmits` nor `maxPacketLifeTime`. So `reliable:false`
 * buys unordered delivery only — SCTP still retransmits forever. That is fine
 * for V1 (unordered is the property input actually needs, so one late packet
 * cannot head-of-line block the ones behind it) but it is NOT the `maxRetransmits: 0`
 * channel that rollback wants. Verified at runtime, see `describeChannels()`.
 *
 * Cost of the second channel: PeerJS calls `_startPeerConnection()` per
 * connection, so each guest costs two RTCPeerConnections (three once media is
 * attached in M2) rather than one PC with three channels. Accepted for V1;
 * V2's raw adapter collapses it.
 */
import { Peer } from 'peerjs';
import type { DataConnection, MediaConnection, PeerOptions } from 'peerjs';

import { Signal } from './emitter.js';
import type { Unsubscribe } from './emitter.js';
import { decodeControl } from './protocol.js';
import type { ControlMessage } from './protocol.js';
import { generateRoomCode, hostPeerId } from './room-code.js';
import type {
  BrokerConfig,
  ChannelDiagnostics,
  ConnectResult,
  PeerId,
  PeerInfo,
  PeerStats,
  Transport,
  TransportError,
  TransportOptions,
  TransportRole,
  TransportStatus,
} from './transport.js';

const CONTROL_LABEL = 'dino-ctl';
const INPUT_LABEL = 'dino-in';

/** PeerJS 1.5 serializer keys. Note: the "no envelope" key is 'raw', NOT 'none'. */
const CONTROL_SERIALIZATION = 'json';
const INPUT_SERIALIZATION = 'raw';

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
/** How many times to roll a fresh room code when the broker ID is squatted. */
const ID_CLAIM_ATTEMPTS = 4;

/** PeerJS error types that leave the Peer unusable. */
const FATAL_PEER_ERRORS = new Set([
  'browser-incompatible',
  'invalid-id',
  'invalid-key',
  'ssl-unavailable',
  'server-error',
  'socket-error',
  'socket-closed',
  'unavailable-id',
]);

interface PeerRecord {
  info: PeerInfo;
  control: DataConnection | null;
  input: DataConnection | null;
  media: MediaConnection | null;
  announced: boolean;
}

interface PeerJsError {
  type?: string;
  message?: string;
}

export class PeerJsTransport implements Transport {
  readonly role: TransportRole;

  #roomCode: string;
  #label: string;
  #broker: BrokerConfig;
  #connectTimeoutMs: number;

  #peer: Peer | null = null;
  #selfId: PeerId | null = null;
  #closed = false;
  /**
   * Set while a guest is dialling. PeerJS reports a nonexistent room as a
   * `peer-unavailable` error on the *Peer*, and leaves the pending
   * DataConnection open forever, so without this hook the guest would sit
   * through the full connect timeout instead of failing in about a second.
   */
  #dialFailure: ((err: Error) => void) | null = null;

  #records = new Map<PeerId, PeerRecord>();
  /** Host: the stream to offer every peer, including ones that join later. */
  #outboundStream: MediaStream | null = null;

  readonly #peerJoin = new Signal<[PeerInfo]>();
  readonly #peerLeave = new Signal<[PeerId, string]>();
  readonly #input = new Signal<[PeerId, Uint8Array, number]>();
  readonly #control = new Signal<[PeerId, ControlMessage]>();
  readonly #stream = new Signal<[PeerId, MediaStream]>();
  readonly #status = new Signal<[TransportStatus, string]>();
  readonly #error = new Signal<[TransportError]>();

  constructor(options: TransportOptions) {
    this.role = options.role;
    this.#roomCode = options.roomCode;
    this.#label = options.label ?? options.role;
    this.#broker = options.broker;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  get roomCode(): string {
    return this.#roomCode;
  }

  get selfId(): PeerId | null {
    return this.#selfId;
  }

  // -- lifecycle ------------------------------------------------------------

  async connect(): Promise<ConnectResult> {
    if (this.#peer) throw new Error('connect() already called on this transport');
    this.#status.emit('connecting', this.role === 'host' ? 'claiming room code' : 'dialing host');
    try {
      const result =
        this.role === 'host' ? await this.#connectAsHost() : await this.#connectAsGuest();
      this.#status.emit('ready', `connected as ${result.selfId}`);
      return result;
    } catch (err) {
      this.#status.emit('error', errorMessage(err));
      throw err;
    }
  }

  async #connectAsHost(): Promise<ConnectResult> {
    let regenerated = false;
    for (let attempt = 1; attempt <= ID_CLAIM_ATTEMPTS; attempt += 1) {
      try {
        const selfId = await this.#openPeer(hostPeerId(this.#roomCode));
        return { selfId, roomCode: this.#roomCode, regenerated };
      } catch (err) {
        // Gotcha #3: custom IDs on the public broker are first-come-first-served.
        // Someone else holding this one is not fatal, it just means roll again.
        if (!isUnavailableId(err) || attempt === ID_CLAIM_ATTEMPTS || this.#closed) throw err;
        this.#teardownPeer();
        this.#roomCode = generateRoomCode();
        regenerated = true;
        this.#status.emit('connecting', `room code was taken, rolled a new one (attempt ${attempt + 1})`);
      }
    }
    /* c8 ignore next */
    throw new Error('unreachable');
  }

  async #connectAsGuest(): Promise<ConnectResult> {
    const selfId = await this.#openPeer(undefined);
    const target = hostPeerId(this.#roomCode);

    // Both channels are dialled at once. The control channel opening is what
    // counts as "joined"; input can lag a beat without blocking anything,
    // because input is redundant by design.
    const control = this.#peer!.connect(target, {
      label: CONTROL_LABEL,
      serialization: CONTROL_SERIALIZATION,
      reliable: true,
      metadata: { label: this.#label },
    });
    const input = this.#peer!.connect(target, {
      label: INPUT_LABEL,
      serialization: INPUT_SERIALIZATION,
      reliable: false,
      metadata: { label: this.#label },
    });

    const record = this.#recordFor(target);
    this.#adoptControl(record, control);
    this.#adoptInput(record, input);

    const dialRejected = new Promise<never>((_, reject) => {
      this.#dialFailure = reject;
    });
    try {
      await Promise.race([
        this.#awaitOpen(control, `host ${target} did not accept the control channel`),
        dialRejected,
      ]);
    } finally {
      this.#dialFailure = null;
    }
    return { selfId, roomCode: this.#roomCode, regenerated: false };
  }

  /** Creates the Peer and resolves with the broker-assigned ID. */
  #openPeer(requestedId: string | undefined): Promise<PeerId> {
    const options = buildPeerOptions(this.#broker);
    const peer = requestedId ? new Peer(requestedId, options) : new Peer(options);
    this.#peer = peer;

    return new Promise<PeerId>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new TransportFailure('broker-timeout', `broker did not respond in ${this.#connectTimeoutMs}ms`));
      }, this.#connectTimeoutMs);

      peer.on('open', (id) => {
        this.#selfId = id;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(id);
      });

      peer.on('error', (raw: PeerJsError) => {
        const type = raw?.type ?? 'unknown';
        const message = raw?.message ?? String(raw);
        const fatal = FATAL_PEER_ERRORS.has(type);
        // The room does not exist. Fail the guest's dial now rather than
        // letting it wait out the connect timeout.
        if (type === 'peer-unavailable' && this.#dialFailure) {
          const fail = this.#dialFailure;
          this.#dialFailure = null;
          fail(new TransportFailure(type, message));
          return;
        }
        if (!settled && fatal) {
          settled = true;
          clearTimeout(timer);
          reject(new TransportFailure(type, message));
          return;
        }
        this.#error.emit({ code: type, message, fatal });
        if (fatal) this.#status.emit('error', `${type}: ${message}`);
      });

      peer.on('disconnected', () => {
        if (this.#closed) return;
        this.#status.emit('reconnecting', 'lost the broker socket, reconnecting');
        // Gotcha #4: the public broker drops sockets. Losing the broker does not
        // drop live WebRTC connections, but it does stop new peers joining.
        try {
          peer.reconnect();
        } catch (err) {
          this.#error.emit({ code: 'reconnect-failed', message: errorMessage(err), fatal: false });
        }
      });

      peer.on('close', () => {
        if (this.#closed) return;
        this.#status.emit('closed', 'broker connection closed');
      });

      // Every peer accepts connections, not just the host: in a mesh a guest is
      // dialled by its fellow guests too.
      peer.on('connection', (conn) => this.#onIncomingData(conn));
      peer.on('call', (call) => this.#onIncomingCall(call));
    });
  }

  dial(peerId: PeerId): void {
    if (this.#closed || !this.#peer || peerId === this.#selfId) return;
    const record = this.#recordFor(peerId);
    // Already connected, or a dial is already in flight.
    if (record.control) return;
    const metadata = { label: this.#label };
    this.#adoptControl(
      record,
      this.#peer.connect(peerId, {
        label: CONTROL_LABEL,
        serialization: CONTROL_SERIALIZATION,
        reliable: true,
        metadata,
      }),
    );
    this.#adoptInput(
      record,
      this.#peer.connect(peerId, {
        label: INPUT_LABEL,
        serialization: INPUT_SERIALIZATION,
        reliable: false,
        metadata,
      }),
    );
  }

  disconnectPeer(peerId: PeerId, reason = 'disconnected by local peer'): void {
    const record = this.#records.get(peerId);
    if (!record) return;
    if (record.control?.open) {
      try {
        record.control.send({ t: 'bye', reason } satisfies ControlMessage);
      } catch {
        /* best effort */
      }
    }
    this.#dropRecord(peerId, reason, true);
  }

  close(reason = 'closed by local peer'): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, record] of this.#records) {
      if (record.control?.open) {
        try {
          record.control.send({ t: 'bye', reason } satisfies ControlMessage);
        } catch {
          /* best effort */
        }
      }
      this.#dropRecord(id, reason, false);
    }
    this.#teardownPeer();
    this.#outboundStream = null;
    this.#status.emit('closed', reason);
    this.#peerJoin.clear();
    this.#peerLeave.clear();
    this.#input.clear();
    this.#control.clear();
    this.#stream.clear();
    this.#error.clear();
    this.#status.clear();
  }

  #teardownPeer(): void {
    const peer = this.#peer;
    this.#peer = null;
    if (!peer) return;
    peer.removeAllListeners();
    if (!peer.destroyed) peer.destroy();
  }

  // -- incoming connections -------------------------------------------------

  #onIncomingData(conn: DataConnection): void {
    const record = this.#recordFor(conn.peer);
    const meta = conn.metadata as { label?: string } | undefined;
    if (typeof meta?.label === 'string') record.info.label = meta.label;

    if (conn.label === CONTROL_LABEL) {
      this.#adoptControl(record, conn);
    } else if (conn.label === INPUT_LABEL) {
      this.#adoptInput(record, conn);
    } else {
      this.#error.emit({
        code: 'unknown-channel',
        message: `peer opened an unrecognised channel "${conn.label}"`,
        fatal: false,
        peerId: conn.peer,
      });
      conn.close();
    }
  }

  #onIncomingCall(call: MediaConnection): void {
    const record = this.#recordFor(call.peer);
    record.media = call;
    // Answering with no stream: V1 media is one-way, host to guest.
    call.answer();
    call.on('stream', (stream) => this.#stream.emit(call.peer, stream));
    call.on('close', () => {
      if (record.media === call) record.media = null;
    });
    call.on('error', (err: PeerJsError) =>
      this.#error.emit({
        code: err?.type ?? 'media-error',
        message: err?.message ?? String(err),
        fatal: false,
        peerId: call.peer,
      }),
    );
  }

  #adoptControl(record: PeerRecord, conn: DataConnection): void {
    record.control?.close();
    record.control = conn;

    conn.on('open', () => {
      if (!record.announced) {
        record.announced = true;
        this.#peerJoin.emit(record.info);
      }
      this.#watchConnectionState(conn);
      // A guest that joins after the host already has a stream still gets it.
      if (this.role === 'host' && this.#outboundStream) this.#callPeer(record.info.id);
    });
    conn.on('data', (raw) => {
      const msg = decodeControl(raw);
      if (!msg) {
        this.#error.emit({
          code: 'bad-control-frame',
          message: 'dropped an undecodable control message',
          fatal: false,
          peerId: conn.peer,
        });
        return;
      }
      this.#control.emit(conn.peer, msg);
    });
    conn.on('close', () => this.#dropRecord(conn.peer, 'control channel closed', true));
    conn.on('error', (err: PeerJsError) =>
      this.#error.emit({
        code: err?.type ?? 'control-error',
        message: err?.message ?? String(err),
        fatal: false,
        peerId: conn.peer,
      }),
    );
  }

  #adoptInput(record: PeerRecord, conn: DataConnection): void {
    record.input?.close();
    record.input = conn;

    conn.on('data', (raw) => {
      const receivedAt = performance.now();
      const bytes = toBytes(raw);
      if (!bytes) {
        this.#error.emit({
          code: 'bad-input-frame',
          message: `input channel delivered a ${describeType(raw)}, expected binary`,
          fatal: false,
          peerId: conn.peer,
        });
        return;
      }
      this.#input.emit(conn.peer, bytes, receivedAt);
    });
    conn.on('close', () => {
      if (record.input === conn) record.input = null;
    });
    conn.on('error', (err: PeerJsError) =>
      this.#error.emit({
        code: err?.type ?? 'input-error',
        message: err?.message ?? String(err),
        fatal: false,
        peerId: conn.peer,
      }),
    );
  }

  /**
   * A browser tab that is killed outright does not always get to close its data
   * channels politely, and PeerJS only surfaces `close` when the channel itself
   * closes. Watching the RTCPeerConnection turns a ~30s ICE timeout into a
   * prompt, definite answer — which matters a great deal to a lockstep game,
   * where a peer nobody has declared dead is a peer everybody waits for.
   */
  #watchConnectionState(conn: DataConnection): void {
    const pc = conn.peerConnection;
    if (!pc) return;
    const onChange = (): void => {
      const state = pc.connectionState;
      if (state === 'failed' || state === 'closed') {
        this.#dropRecord(conn.peer, `webrtc connection ${state}`, true);
      } else if (state === 'disconnected') {
        // Often transient; report it but do not act on it.
        this.#error.emit({
          code: 'peer-disconnected',
          message: 'webrtc connection disconnected, may recover',
          fatal: false,
          peerId: conn.peer,
        });
      }
    };
    pc.addEventListener('connectionstatechange', onChange);
    pc.addEventListener('iceconnectionstatechange', () => {
      if (pc.iceConnectionState === 'failed') {
        this.#dropRecord(conn.peer, 'ice connection failed', true);
      }
    });
  }

  #recordFor(peerId: PeerId): PeerRecord {
    let record = this.#records.get(peerId);
    if (!record) {
      record = {
        info: { id: peerId, label: peerId, joinedAt: Date.now() },
        control: null,
        input: null,
        media: null,
        announced: false,
      };
      this.#records.set(peerId, record);
    }
    return record;
  }

  #dropRecord(peerId: PeerId, reason: string, announce: boolean): void {
    const record = this.#records.get(peerId);
    if (!record) return;
    this.#records.delete(peerId);
    record.input?.close();
    record.control?.close();
    record.media?.close();
    if (announce && record.announced) this.#peerLeave.emit(peerId, reason);
  }

  #awaitOpen(conn: DataConnection, timeoutMessage: string): Promise<void> {
    if (conn.open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new TransportFailure('connect-timeout', timeoutMessage));
      }, this.#connectTimeoutMs);
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onFail = (err?: PeerJsError): void => {
        cleanup();
        reject(new TransportFailure(err?.type ?? 'connection-closed', err?.message ?? timeoutMessage));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        conn.off('open', onOpen);
        conn.off('error', onFail);
        conn.off('close', onFail);
      };
      conn.on('open', onOpen);
      conn.on('error', onFail);
      conn.on('close', onFail);
    });
  }

  // -- sending --------------------------------------------------------------

  sendControl(msg: ControlMessage, to?: PeerId): void {
    for (const record of this.#targets(to)) {
      if (!record.control?.open) continue;
      try {
        record.control.send(msg);
      } catch (err) {
        this.#error.emit({
          code: 'control-send-failed',
          message: errorMessage(err),
          fatal: false,
          peerId: record.info.id,
        });
      }
    }
  }

  sendInput(payload: Uint8Array, to?: PeerId): void {
    for (const record of this.#targets(to)) {
      // Never queue, never retransmit: gotcha #5. A packet that cannot go out
      // right now is already stale, and the next one carries its frames anyway.
      if (!record.input?.open) continue;
      try {
        record.input.send(payload);
      } catch {
        /* dropped on purpose */
      }
    }
  }

  attachStream(stream: MediaStream, to?: PeerId): void {
    if (!to) this.#outboundStream = stream;
    for (const record of this.#targets(to)) {
      this.#callPeer(record.info.id, stream);
    }
  }

  #callPeer(peerId: PeerId, stream = this.#outboundStream): void {
    const peer = this.#peer;
    const record = this.#records.get(peerId);
    if (!peer || !record || !stream) return;
    if (record.media) return; // already streaming to this peer
    const call = peer.call(peerId, stream);
    record.media = call;
    call.on('close', () => {
      if (record.media === call) record.media = null;
    });
    call.on('error', (err: PeerJsError) =>
      this.#error.emit({
        code: err?.type ?? 'media-error',
        message: err?.message ?? String(err),
        fatal: false,
        peerId,
      }),
    );
  }

  #targets(to?: PeerId): PeerRecord[] {
    if (to === undefined) return [...this.#records.values()];
    const record = this.#records.get(to);
    return record ? [record] : [];
  }

  // -- subscriptions --------------------------------------------------------

  onPeerJoin(cb: (peer: PeerInfo) => void): Unsubscribe {
    return this.#peerJoin.on(cb);
  }
  onPeerLeave(cb: (peerId: PeerId, reason: string) => void): Unsubscribe {
    return this.#peerLeave.on(cb);
  }
  onInput(cb: (from: PeerId, payload: Uint8Array, receivedAt: number) => void): Unsubscribe {
    return this.#input.on(cb);
  }
  onControl(cb: (from: PeerId, msg: ControlMessage) => void): Unsubscribe {
    return this.#control.on(cb);
  }
  onStream(cb: (from: PeerId, stream: MediaStream) => void): Unsubscribe {
    return this.#stream.on(cb);
  }
  onStatus(cb: (status: TransportStatus, detail: string) => void): Unsubscribe {
    return this.#status.on(cb);
  }
  onError(cb: (err: TransportError) => void): Unsubscribe {
    return this.#error.on(cb);
  }

  // -- introspection --------------------------------------------------------

  getPeers(): PeerInfo[] {
    return [...this.#records.values()].filter((r) => r.announced).map((r) => r.info);
  }

  describeChannels(): ChannelDiagnostics[] {
    const out: ChannelDiagnostics[] = [];
    for (const record of this.#records.values()) {
      if (record.control) out.push(describeChannel(record.info.id, 'control', record.control, true, CONTROL_SERIALIZATION));
      if (record.input) out.push(describeChannel(record.info.id, 'input', record.input, false, INPUT_SERIALIZATION));
    }
    return out;
  }

  async getPeerStats(peerId: PeerId): Promise<PeerStats | null> {
    const pc = this.#records.get(peerId)?.control?.peerConnection;
    if (!pc) return null;
    let report: RTCStatsReport;
    try {
      report = await pc.getStats();
    } catch {
      return null;
    }
    return summarizeStats(peerId, report);
  }
}

// -- helpers ----------------------------------------------------------------

class TransportFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'TransportFailure';
    this.code = code;
  }
}

function isUnavailableId(err: unknown): boolean {
  return err instanceof TransportFailure && err.code === 'unavailable-id';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Only include keys the caller actually set. PeerJS falls back to its cloud
 * broker defaults for anything absent, and passing `undefined` explicitly is
 * not the same thing as omitting it.
 */
function buildPeerOptions(broker: BrokerConfig): PeerOptions {
  const options: PeerOptions = {};
  if (broker.host !== undefined) options.host = broker.host;
  if (broker.port !== undefined) options.port = broker.port;
  if (broker.path !== undefined) options.path = broker.path;
  if (broker.secure !== undefined) options.secure = broker.secure;
  if (broker.key !== undefined) options.key = broker.key;
  if (broker.debugLevel !== undefined) options.debug = broker.debugLevel;
  if (broker.iceServers?.length) options.config = { iceServers: broker.iceServers };
  return options;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  return value.constructor?.name ?? 'object';
}

function describeChannel(
  peerId: PeerId,
  kind: 'control' | 'input',
  conn: DataConnection,
  requestedReliable: boolean,
  requestedSerialization: string,
): ChannelDiagnostics {
  const dc = conn.dataChannel as RTCDataChannel | null | undefined;
  return {
    peerId,
    kind,
    label: conn.label,
    requestedReliable,
    requestedSerialization,
    readyState: dc?.readyState ?? 'missing',
    ordered: dc ? dc.ordered : null,
    maxRetransmits: dc ? dc.maxRetransmits : null,
    maxPacketLifeTime: dc ? dc.maxPacketLifeTime : null,
    negotiated: dc ? dc.negotiated : null,
    id: dc ? dc.id : null,
    binaryType: dc ? dc.binaryType : null,
  };
}

function summarizeStats(peerId: PeerId, report: RTCStatsReport): PeerStats {
  const byId = new Map<string, Record<string, unknown>>();
  let pair: Record<string, unknown> | null = null;
  let transportSelectedPairId: string | null = null;

  report.forEach((entry) => {
    const stat = entry as unknown as Record<string, unknown>;
    byId.set(String(stat['id']), stat);
    if (stat['type'] === 'transport' && typeof stat['selectedCandidatePairId'] === 'string') {
      transportSelectedPairId = stat['selectedCandidatePairId'];
    }
  });

  if (transportSelectedPairId) pair = byId.get(transportSelectedPairId) ?? null;
  if (!pair) {
    // Firefox does not always expose transport.selectedCandidatePairId.
    for (const stat of byId.values()) {
      if (stat['type'] === 'candidate-pair' && (stat['nominated'] === true || stat['selected'] === true) && stat['state'] === 'succeeded') {
        pair = stat;
        break;
      }
    }
  }

  const local = pair && typeof pair['localCandidateId'] === 'string' ? byId.get(pair['localCandidateId']) : undefined;
  const remote = pair && typeof pair['remoteCandidateId'] === 'string' ? byId.get(pair['remoteCandidateId']) : undefined;
  const localType = typeof local?.['candidateType'] === 'string' ? (local['candidateType'] as string) : null;
  const remoteType = typeof remote?.['candidateType'] === 'string' ? (remote['candidateType'] as string) : null;
  const rttSeconds = pair && typeof pair['currentRoundTripTime'] === 'number' ? pair['currentRoundTripTime'] : null;

  return {
    peerId,
    rttMs: rttSeconds === null ? null : Math.round(rttSeconds * 10_000) / 10,
    localCandidateType: localType,
    remoteCandidateType: remoteType,
    relayed: localType === 'relay' || remoteType === 'relay',
    availableOutgoingBitrateBps:
      pair && typeof pair['availableOutgoingBitrate'] === 'number' ? pair['availableOutgoingBitrate'] : null,
    bytesSent: pair && typeof pair['bytesSent'] === 'number' ? pair['bytesSent'] : null,
    bytesReceived: pair && typeof pair['bytesReceived'] === 'number' ? pair['bytesReceived'] : null,
  };
}
