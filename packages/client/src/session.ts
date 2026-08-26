import {
  GUEST_SLOTS,
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  PeerJsTransport,
  Signal,
  formatRoomCode,
} from '@dino/shared';
import type {
  BrokerConfig,
  ChannelDiagnostics,
  ControlMessage,
  PeerId,
  PeerStats,
  PlayerSlot,
  Transport,
  TransportError,
  TransportRole,
  TransportStatus,
  Unsubscribe,
} from '@dino/shared';

import type { Log } from './log.js';

/**
 * Everything above the Transport seam: who is in the room, which emulator port
 * they drive, and the hello/welcome handshake that decides it.
 *
 * The transport deliberately knows nothing about player slots. Swapping PeerJS
 * for a raw RTCPeerConnection stack in V2 does not touch this file.
 */

export interface Player {
  peerId: PeerId;
  slot: PlayerSlot;
  label: string;
  isSelf: boolean;
  joinedAt: number;
}

export interface SessionOptions {
  role: TransportRole;
  roomCode: string;
  broker: BrokerConfig;
  label: string;
  log: Log;
}

/** The host always drives player 1: it is the machine running the emulator. */
const HOST_SLOT: PlayerSlot = 1;

export class Session {
  readonly role: TransportRole;
  readonly #transport: Transport;
  readonly #log: Log;
  readonly #label: string;

  #players = new Map<PeerId, Player>();
  /** Slots learned from the host's roster, which may arrive before the peer. */
  #knownSlots = new Map<PeerId, PlayerSlot>();
  #selfId: PeerId | null = null;
  #selfSlot: PlayerSlot | null = null;
  #rejectedReason: string | null = null;
  #roomCode: string;
  #status: TransportStatus = 'idle';
  #unsubscribes: Unsubscribe[] = [];

  readonly roster = new Signal<[Player[]]>();
  readonly chat = new Signal<[{ from: PeerId; label: string; text: string; mine: boolean }]>();
  readonly statusChanged = new Signal<[TransportStatus, string]>();
  /** The host refused us — room full, or a protocol mismatch. */
  readonly rejected = new Signal<[string]>();

  constructor(options: SessionOptions) {
    this.role = options.role;
    this.#log = options.log;
    this.#label = options.label;
    this.#roomCode = options.roomCode;
    this.#transport = new PeerJsTransport({
      role: options.role,
      roomCode: options.roomCode,
      broker: options.broker,
      label: options.label,
    });
  }

  get transport(): Transport {
    return this.#transport;
  }
  get roomCode(): string {
    return this.#roomCode;
  }
  get prettyRoomCode(): string {
    return formatRoomCode(this.#roomCode);
  }
  get selfId(): PeerId | null {
    return this.#selfId;
  }
  get selfSlot(): PlayerSlot | null {
    return this.#selfSlot;
  }
  get status(): TransportStatus {
    return this.#status;
  }
  get players(): Player[] {
    return [...this.#players.values()].sort((a, b) => a.slot - b.slot);
  }

  /**
   * Resolves once we know which player we are. A host knows immediately; a
   * guest only learns it when `welcome` comes back, which is after connect().
   */
  waitForSlot(timeoutMs = 15000): Promise<PlayerSlot> {
    if (this.#selfSlot !== null) return Promise.resolve(this.#selfSlot);
    if (this.#rejectedReason !== null) return Promise.reject(new Error(this.#rejectedReason));
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        unRoster();
        unRejected();
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error('the host never assigned us a player slot'));
      }, timeoutMs);
      // Being turned away is an answer too, and a much faster one than waiting
      // out the timeout.
      const unRejected = this.rejected.on((reason) => {
        done();
        reject(new Error(reason));
      });
      const unRoster = this.roster.on(() => {
        if (this.#selfSlot === null) return;
        done();
        resolve(this.#selfSlot);
      });
    });
  }

  /** Emulator port a peer drives, or null if we never seated them. */
  portForPeer(peerId: PeerId): number | null {
    const slot = this.#players.get(peerId)?.slot;
    return slot === undefined ? null : slot - 1;
  }

  async start(): Promise<void> {
    this.#wire();
    const result = await this.#transport.connect();
    this.#selfId = result.selfId;
    this.#roomCode = result.roomCode;

    if (this.role === 'host') {
      this.#selfSlot = HOST_SLOT;
      this.#addPlayer({
        peerId: result.selfId,
        slot: HOST_SLOT,
        label: this.#label,
        isSelf: true,
        joinedAt: Date.now(),
      });
      if (result.regenerated) {
        this.#log.warn('room code was already claimed on the broker, rolled a new one', {
          roomCode: this.#roomCode,
        });
      }
      this.#log.info('hosting', { selfId: result.selfId, roomCode: this.prettyRoomCode });
    } else {
      this.#log.info('connected to host, sending hello', { selfId: result.selfId });
      this.#transport.sendControl({ t: 'hello', protocol: PROTOCOL_VERSION, label: this.#label });
    }
  }

  #wire(): void {
    const t = this.#transport;
    this.#unsubscribes.push(
      t.onStatus((status, detail) => {
        this.#status = status;
        this.#log.net(`transport ${status}`, detail);
        this.statusChanged.emit(status, detail);
      }),
      t.onError((err) => this.#onError(err)),
      t.onPeerJoin((peer) => {
        this.#log.net('peer channel open', { peerId: peer.id, label: peer.label });
        // The host waits for `hello` before handing out a slot. A guest seats
        // the peer it dialled as the host only if it does not already know
        // better from a roster — in a mesh, a guest's peers include other
        // guests, and assuming every peer is player 1 would be wrong.
        if (this.role === 'guest' && !this.#players.has(peer.id) && !this.#knownSlots.has(peer.id)) {
          this.#addPlayer({
            peerId: peer.id,
            slot: HOST_SLOT,
            label: peer.label,
            isSelf: false,
            joinedAt: peer.joinedAt,
          });
        }
      }),
      t.onPeerLeave((peerId, reason) => {
        const player = this.#players.get(peerId);
        this.#players.delete(peerId);
        this.#knownSlots.delete(peerId);
        this.#log.net('peer left', { peerId, slot: player?.slot ?? null, reason });
        this.roster.emit(this.players);
        this.#broadcastRoster();
      }),
      t.onControl((from, msg) => this.#onControl(from, msg)),
    );
  }

  #onControl(from: PeerId, msg: ControlMessage): void {
    switch (msg.t) {
      case 'hello': {
        if (this.role !== 'host') return;
        if (msg.protocol !== PROTOCOL_VERSION) {
          const reason = `protocol mismatch: host speaks v${PROTOCOL_VERSION}, guest speaks v${msg.protocol}`;
          this.#log.warn('rejecting guest', { peerId: from, reason });
          this.#transport.sendControl({ t: 'reject', reason }, from);
          this.#transport.disconnectPeer(from, reason);
          return;
        }
        const slot = this.#allocateSlot();
        if (slot === null) {
          const reason = `room is full (${MAX_PLAYERS} players)`;
          this.#log.warn('rejecting guest', { peerId: from, reason });
          this.#transport.sendControl({ t: 'reject', reason }, from);
          this.#transport.disconnectPeer(from, reason);
          return;
        }
        this.#addPlayer({
          peerId: from,
          slot,
          label: msg.label || from,
          isSelf: false,
          joinedAt: Date.now(),
        });
        this.#transport.sendControl(
          { t: 'welcome', protocol: PROTOCOL_VERSION, slot, label: this.#label },
          from,
        );
        this.#log.info(`player ${slot} joined`, { peerId: from, label: msg.label });
        this.#broadcastRoster();
        return;
      }
      case 'welcome': {
        if (this.role !== 'guest' || this.#selfId === null) return;
        this.#selfSlot = msg.slot;
        const host = this.#players.get(from);
        if (host) host.label = msg.label || host.label;
        this.#addPlayer({
          peerId: this.#selfId,
          slot: msg.slot,
          label: this.#label,
          isSelf: true,
          joinedAt: Date.now(),
        });
        this.#log.info(`host assigned us player ${msg.slot}`, { host: from });
        return;
      }
      case 'roster': {
        if (this.role !== 'guest') return;
        this.#applyRoster(msg.players);
        return;
      }
      case 'reject': {
        this.#log.error('host rejected us', { reason: msg.reason });
        this.#rejectedReason = msg.reason;
        this.statusChanged.emit('error', msg.reason);
        this.rejected.emit(msg.reason);
        return;
      }
      case 'bye': {
        this.#log.net('peer said goodbye', { peerId: from, reason: msg.reason });
        return;
      }
      case 'chat': {
        const label = this.#players.get(from)?.label ?? from;
        this.#log.info('chat received', { from, label, text: msg.text });
        this.chat.emit({ from, label, text: msg.text, mine: false });
        return;
      }
    }
  }

  #onError(err: TransportError): void {
    const fn = err.fatal ? this.#log.error.bind(this.#log) : this.#log.warn.bind(this.#log);
    fn(`transport error: ${err.code}`, { message: err.message, peerId: err.peerId });
  }

  /** Host only: tell everyone who is in the room, so guests can find each other. */
  #broadcastRoster(): void {
    if (this.role !== 'host') return;
    this.#transport.sendControl({
      t: 'roster',
      players: this.players.map((p) => ({ peerId: p.peerId, slot: p.slot, label: p.label })),
    });
  }

  /**
   * Guest side of the mesh. The host names everyone; we seat them and dial the
   * ones we are not connected to yet.
   *
   * Both ends of a pair would otherwise dial each other at the same moment and
   * end up with two connections, so the lower peer ID does the dialling and the
   * higher one waits. Arbitrary, but both sides agree on it without talking.
   */
  #applyRoster(entries: Array<{ peerId: PeerId; slot: PlayerSlot; label: string }>): void {
    const selfId = this.#selfId;
    if (selfId === null) return;
    for (const entry of entries) {
      this.#knownSlots.set(entry.peerId, entry.slot);
      if (entry.peerId === selfId) continue;
      const existing = this.#players.get(entry.peerId);
      if (existing) {
        existing.slot = entry.slot;
        existing.label = entry.label || existing.label;
      } else {
        this.#players.set(entry.peerId, {
          peerId: entry.peerId,
          slot: entry.slot,
          label: entry.label || entry.peerId,
          isSelf: false,
          joinedAt: Date.now(),
        });
      }
      if (selfId < entry.peerId) this.#transport.dial(entry.peerId);
    }
    // Anyone the host no longer lists has left.
    const live = new Set([selfId, ...entries.map((e) => e.peerId)]);
    for (const id of [...this.#players.keys()]) {
      if (!live.has(id)) {
        this.#players.delete(id);
        this.#knownSlots.delete(id);
      }
    }
    this.#log.net('roster updated', { players: entries.map((e) => `P${e.slot}`) });
    this.roster.emit(this.players);
  }

  #allocateSlot(): PlayerSlot | null {
    const taken = new Set([...this.#players.values()].map((p) => p.slot));
    for (const slot of GUEST_SLOTS) {
      if (!taken.has(slot)) return slot;
    }
    return null;
  }

  #addPlayer(player: Player): void {
    this.#players.set(player.peerId, player);
    this.roster.emit(this.players);
  }

  /** M0 smoke test: prove arbitrary strings cross the control channel. */
  sendChat(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.#transport.sendControl({ t: 'chat', text: trimmed });
    this.#log.info('chat sent', { text: trimmed });
    this.chat.emit({
      from: this.#selfId ?? 'self',
      label: this.#label,
      text: trimmed,
      mine: true,
    });
  }

  describeChannels(): ChannelDiagnostics[] {
    return this.#transport.describeChannels();
  }

  async peerStats(): Promise<Record<PeerId, PeerStats | null>> {
    const out: Record<PeerId, PeerStats | null> = {};
    await Promise.all(
      this.players
        .filter((p) => !p.isSelf)
        .map(async (p) => {
          out[p.peerId] = await this.#transport.getPeerStats(p.peerId);
        }),
    );
    return out;
  }

  close(reason = 'left the room'): void {
    // Close first, unsubscribe second, so the final 'closed' status still
    // reaches the UI.
    this.#transport.close(reason);
    for (const un of this.#unsubscribes) un();
    this.#unsubscribes = [];
    this.#players.clear();
    this.roster.emit([]);
  }
}
