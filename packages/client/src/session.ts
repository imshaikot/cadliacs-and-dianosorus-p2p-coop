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
  #selfId: PeerId | null = null;
  #selfSlot: PlayerSlot | null = null;
  #roomCode: string;
  #status: TransportStatus = 'idle';
  #unsubscribes: Unsubscribe[] = [];

  readonly roster = new Signal<[Player[]]>();
  readonly chat = new Signal<[{ from: PeerId; label: string; text: string; mine: boolean }]>();
  readonly statusChanged = new Signal<[TransportStatus, string]>();

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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        un();
        reject(new Error('the host never assigned us a player slot'));
      }, timeoutMs);
      const un = this.roster.on(() => {
        if (this.#selfSlot === null) return;
        clearTimeout(timer);
        un();
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
        // The host waits for `hello` before handing out a slot; the guest treats
        // the host as player 1 immediately.
        if (this.role === 'guest') {
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
        this.#log.net('peer left', { peerId, slot: player?.slot ?? null, reason });
        this.roster.emit(this.players);
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
      case 'reject': {
        this.#log.error('host rejected us', { reason: msg.reason });
        this.statusChanged.emit('error', msg.reason);
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
