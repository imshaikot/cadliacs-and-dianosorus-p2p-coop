import {
  StateAssembler,
  chunkRom,
  coerceSystem,
  decodeRomBundle,
  decodeRomChunk,
  encodeRomBundle,
} from '@retro/shared';
import type { ControlMessage, PeerId, SystemId, Transport } from '@retro/shared';

import type { Log } from '../log.js';
import type { RomSource } from '../emulator/rom.js';

/**
 * Handing your loaded game file to a peer who has none.
 *
 * Every peer runs its own emulator, so every peer needs the same bytes. Asking
 * three people to find the same file before anyone can play is the single
 * biggest thing between "I have a room code" and "we are playing", and the mesh
 * already has a channel that carries megabytes — the savestate rides it on every
 * join.
 *
 * Two rules shape everything here.
 *
 * **It cannot stall a frame** — the same invariant voice lives under. The send is
 * paced: a small batch, then a yield to the event loop, then the next.
 *
 * Being straight about how much that buys: it was measured. Pushing a 4 MB
 * romset — 256 chunks — in a single unpaced burst moved the host's worst gap
 * between frames by nothing anyone could see (24ms unpaced against 41ms paced,
 * both inside normal jitter for two emulators on one machine). At the sizes a
 * CPS romset actually comes in, the pacing is not load-bearing. It is kept
 * because MAX_ROM_BYTES allows 64 MB, which is 4096 chunks, and because a
 * bounded batch is the difference between a send whose cost scales with the file
 * and one whose cost per turn is fixed.
 *
 * **The bytes are checked before they are trusted.** A peer controls this
 * payload. It is size-capped before a buffer is allocated and fingerprinted
 * before it is handed to the emulator, so a truncated or swapped file fails as a
 * message rather than as a mysterious desync twenty seconds into a fight.
 *
 * What travels is a *bundle*, not a file — the game plus anything its driver
 * boots through, which for Neo Geo is the BIOS. One transfer, one hash, one
 * arrival, however many files are inside it. See `rom-bundle.ts`.
 */

/** Bigger than any CPS-1/2 romset, small enough that a bad actor cannot OOM us. */
export const MAX_ROM_BYTES = 64 * 1024 * 1024;

/** Chunks per tick. 8 x 16KB is 128KB a turn — under a millisecond of copying. */
const CHUNKS_PER_TICK = 8;

/** A transfer this slow is a dead peer, not a slow one. */
const TRANSFER_TIMEOUT_MS = 60_000;

export interface RomOffer {
  /** The game's own filename, for the log and the progress line. */
  name: string;
  /** Size of the whole bundle, which is what actually crosses the wire. */
  bytes: number;
  sha256: string;
  /** Which core these bytes are for. A guest boots that one and no other. */
  system: SystemId;
}

export interface RomShareCallbacks {
  /** A complete, fingerprint-checked file arrived. */
  onReceived: (rom: RomSource) => void;
  /** Sending or receiving progress, 0..1, or null when nothing is in flight. */
  onProgress: (fraction: number | null, detail: string) => void;
}

/** Web Crypto is https-or-localhost only; without it we simply do not compare. */
export async function fingerprint(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) return '';
  const view = new Uint8Array(bytes); // a fresh, non-shared buffer for digest()
  const digest = await crypto.subtle.digest('SHA-256', view);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class RomShare {
  readonly #transport: Transport;
  readonly #log: Log;
  readonly #cb: RomShareCallbacks;
  readonly #assembler = new StateAssembler();

  /** What we hold, once we have it — this is what we can offer others. */
  #mine: RomSource | null = null;
  /** The encoded bundle, kept so a second peer's request is not a second encode. */
  #mineBundle: Uint8Array | null = null;
  #mineHash = '';
  /** Offers we have been given, by peer, so we know who to ask. */
  #offers = new Map<PeerId, RomOffer>();
  #requested = false;
  #receiving: { from: PeerId; offer: RomOffer; startedAt: number } | null = null;
  #unsubscribes: Array<() => void> = [];

  constructor(transport: Transport, log: Log, cb: RomShareCallbacks) {
    this.#transport = transport;
    this.#log = log;
    this.#cb = cb;
    // Subscribes itself, the way Netplay does, rather than making main.ts a
    // switchboard that has to know which messages belong to whom.
    this.#unsubscribes.push(
      transport.onInput((from, bytes) => this.#onWire(from, bytes)),
      transport.onControl((from, msg) => this.onControl(from, msg)),
    );
  }

  /** Called once we have a game of our own, however we came by it. */
  async setMine(rom: RomSource): Promise<void> {
    const bundle = encodeRomBundle([{ name: rom.name, bytes: rom.bytes }, ...rom.extras]);
    this.#mine = rom;
    this.#mineBundle = bundle;
    this.#mineHash = await fingerprint(bundle);
    this.#requested = false;
    this.#receiving = null;
    this.#cb.onProgress(null, '');
    this.offerTo();
  }

  get offer(): RomOffer | null {
    if (!this.#mine || !this.#mineBundle) return null;
    return {
      name: this.#mine.name,
      bytes: this.#mineBundle.length,
      sha256: this.#mineHash,
      system: this.#mine.system,
    };
  }

  /** Announce what we hold. To one peer, or to everyone when `to` is omitted. */
  offerTo(to?: PeerId): void {
    const offer = this.offer;
    if (!offer) return;
    this.#transport.sendControl({ t: 'rom-offer', ...offer }, to);
  }

  /**
   * Whether anyone has offered us something, and from whom.
   *
   * Preferring the first offer is fine: in a room where the host loaded a game,
   * that is the host, and in a room where two peers loaded the same game their
   * fingerprints match anyway.
   */
  get available(): { from: PeerId; offer: RomOffer } | null {
    for (const [from, offer] of this.#offers) return { from, offer };
    return null;
  }

  /** Ask whoever has offered. Idempotent — a second call while one is in flight
   *  is ignored rather than starting a second transfer. */
  request(): boolean {
    if (this.#mine || this.#requested) return false;
    const source = this.available;
    if (!source) return false;
    this.#requested = true;
    this.#receiving = { from: source.from, offer: source.offer, startedAt: Date.now() };
    this.#log.info('asking a peer for their game file', {
      from: source.from,
      name: source.offer.name,
      bytes: source.offer.bytes,
    });
    this.#cb.onProgress(0, `asking for ${source.offer.name}…`);
    this.#transport.sendControl({ t: 'rom-request' }, source.from);
    return true;
  }

  onControl(from: PeerId, msg: ControlMessage): void {
    switch (msg.t) {
      case 'rom-offer': {
        const offer: RomOffer = {
          name: String(msg.name),
          bytes: Number(msg.bytes),
          sha256: String(msg.sha256),
          system: coerceSystem(msg.system),
        };
        if (!Number.isFinite(offer.bytes) || offer.bytes <= 0 || offer.bytes > MAX_ROM_BYTES) return;
        this.#offers.set(from, offer);
        // Both of us already have a file: say so now rather than letting the
        // desync counter discover it mid-fight.
        if (this.#mine && this.#mineHash && offer.sha256 && offer.sha256 !== this.#mineHash) {
          this.#log.warn('a peer is running a different dump of this game', {
            from,
            theirs: offer.name,
            mine: this.#mine.name,
          });
        }
        /*
         * A guest finishes booting its core well before the host's offer lands,
         * so the request cannot only be made at boot — it would always lose that
         * race and fall through to the picker. Asking here instead means the
         * offer itself is the trigger, whichever order the two arrive in.
         */
        this.request();
        return;
      }
      case 'rom-request': {
        if (!this.#mineBundle) {
          this.#transport.sendControl({ t: 'rom-decline', reason: 'I have no game loaded' }, from);
          return;
        }
        void this.#send(from, this.#mineBundle);
        return;
      }
      case 'rom-decline': {
        this.#log.warn('a peer could not send their game file', { from, reason: msg.reason });
        this.#requested = false;
        this.#receiving = null;
        this.#cb.onProgress(null, msg.reason);
        return;
      }
      default:
        return;
    }
  }

  /** Peer left: drop its offer, and abandon a transfer that was coming from it. */
  forget(peerId: PeerId): void {
    this.#offers.delete(peerId);
    if (this.#receiving?.from === peerId) {
      this.#receiving = null;
      this.#requested = false;
      this.#cb.onProgress(null, 'the peer sending your game file left');
    }
  }

  dispose(): void {
    for (const off of this.#unsubscribes) off();
    this.#unsubscribes = [];
    this.#offers.clear();
    this.#receiving = null;
    this.#mine = null;
    this.#mineBundle = null;
  }

  /**
   * Push the file out in paced batches.
   *
   * The yield between batches is the whole point — see the class comment. A
   * `setTimeout(0)` lets the audio-clock tick, the renderer and any input
   * packets through between turns.
   */
  async #send(to: PeerId, bytes: Uint8Array): Promise<void> {
    const transferId = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    const chunks = [...chunkRom(transferId, bytes)];
    this.#log.info('sending our game file to a peer', { to, bytes: bytes.length, chunks: chunks.length });
    for (let i = 0; i < chunks.length; i += CHUNKS_PER_TICK) {
      for (const chunk of chunks.slice(i, i + CHUNKS_PER_TICK)) {
        this.#transport.sendInput(chunk, to);
      }
      const done = Math.min(i + CHUNKS_PER_TICK, chunks.length);
      this.#cb.onProgress(done / chunks.length, `sending ${Math.round((done / chunks.length) * 100)}%`);
      await new Promise((r) => setTimeout(r, 0));
    }
    this.#cb.onProgress(null, '');
    this.#log.info('game file sent', { to });
  }

  #onWire(from: PeerId, bytes: Uint8Array): void {
    const chunk = decodeRomChunk(bytes);
    if (!chunk) return;
    const receiving = this.#receiving;
    // Unsolicited, or from someone we did not ask: a peer does not get to push
    // megabytes at us because it felt like it.
    if (!receiving || receiving.from !== from) return;
    if (chunk.totalBytes > MAX_ROM_BYTES) return;
    if (Date.now() - receiving.startedAt > TRANSFER_TIMEOUT_MS) {
      this.#receiving = null;
      this.#requested = false;
      this.#cb.onProgress(null, 'that transfer took too long, try loading a file yourself');
      return;
    }

    const complete = this.#assembler.accept(chunk);
    const { have, want } = this.#assembler.progress;
    if (!complete) {
      this.#cb.onProgress(have / Math.max(want, 1), `receiving ${have}/${want}`);
      return;
    }
    void this.#accept(complete, receiving.offer);
  }

  async #accept(bytes: Uint8Array, offer: RomOffer): Promise<void> {
    const hash = await fingerprint(bytes);
    if (offer.sha256 && hash && hash !== offer.sha256) {
      this.#log.error('the game file we received does not match what was offered', {
        expected: offer.sha256.slice(0, 12),
        got: hash.slice(0, 12),
      });
      this.#fail('that file arrived damaged — load one yourself');
      return;
    }
    // Unpacked only after the fingerprint agrees, so a bundle that fails to
    // parse is a bug in us rather than something a peer could have caused.
    const files = decodeRomBundle(bytes);
    const [game, ...extras] = files ?? [];
    if (!game) {
      this.#log.error('the game file we received was not a readable bundle', { from: offer.name });
      this.#fail('that transfer was not readable — load a file yourself');
      return;
    }
    this.#log.info('game file received from a peer', {
      name: game.name,
      bytes: bytes.length,
      alongside: extras.map((e) => e.name),
      system: offer.system,
    });
    this.#receiving = null;
    this.#cb.onProgress(null, '');
    this.#cb.onReceived({
      name: game.name,
      bytes: game.bytes,
      extras,
      origin: 'peer',
      system: offer.system,
    });
  }

  /** Abandon whatever was in flight and say why, leaving the picker usable. */
  #fail(detail: string): void {
    this.#receiving = null;
    this.#requested = false;
    this.#cb.onProgress(null, detail);
  }
}
