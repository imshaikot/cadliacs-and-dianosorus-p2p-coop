import {
  StateAssembler,
  WireKind,
  chunkState,
  decodeStateChunk,
} from '@dino/shared';
import type { ControlMessage, PeerId } from '@dino/shared';

import type { Machine } from '../emulator/machine.js';
import type { Log } from '../log.js';
import type { Session } from '../session.js';
import { CHECKSUM_INTERVAL_FRAMES, Lockstep } from './lockstep.js';

/**
 * Ties the emulator to the network.
 *
 * The one rule that makes lockstep tractable: **every membership change is a
 * resync.** A peer joining, a peer leaving, a peer's emulator becoming ready —
 * all of them stop the clock, take a savestate from the coordinator, hand it to
 * everyone, and restart from that exact frame with an explicit port list.
 *
 * The alternative — letting peers work out for themselves which frame a
 * departed player stopped at — is where lockstep implementations go to die.
 * Each peer holds a different amount of the departed peer's final inputs, so
 * each would fill the gap differently, and they would silently diverge. Paying
 * a fraction of a second of hitch per join or leave buys that whole class of
 * bug away.
 *
 * The host is the coordinator. It is not authoritative over the simulation —
 * every peer computes every frame — it just decides membership.
 */
export interface NetplayOptions {
  session: Session;
  machine: Machine;
  log: Log;
  /** Fixed input delay in frames, or null to derive it from measured RTT. */
  delayFramesOverride: number | null;
  /** How long a peer may go silent before we declare it gone. */
  peerTimeoutMs: number;
}

export interface NetplayStatus {
  phase: 'solo' | 'syncing' | 'lockstep' | 'stalled';
  detail: string;
}

const MIN_DELAY_FRAMES = 2;
const MAX_DELAY_FRAMES = 12;
/** Extra frames on top of measured one-way latency, to absorb jitter. */
const JITTER_MARGIN_FRAMES = 1;

export class Netplay {
  readonly lockstep: Lockstep;
  #session: Session;
  #machine: Machine;
  #log: Log;
  #delayOverride: number | null;

  #assembler = new StateAssembler();
  #pendingBegin: { frame: number; ports: number[]; delayFrames: number; transferId: number } | null = null;
  /**
   * A completed state whose `begin` has not landed yet.
   *
   * `begin` rides the ordered control channel while the state rides the
   * unordered input channel, and nothing orders one against the other — the
   * whole savestate can and does arrive first. Holding it here until both
   * halves are present is what stops that being a race.
   */
  #orphanState = new Map<number, Uint8Array>();
  #transferId = 1;
  #readyPorts = new Set<number>();
  #selfPort: number;
  #phase: NetplayStatus['phase'] = 'solo';
  #detail = 'running solo';
  #resyncs = 0;
  #rttByPort: Record<number, number | null> = {};
  #onStatus: ((s: NetplayStatus) => void) | null = null;
  #unsubscribes: Array<() => void> = [];

  constructor(options: NetplayOptions) {
    this.#session = options.session;
    this.#machine = options.machine;
    this.#log = options.log;
    this.#delayOverride = options.delayFramesOverride;
    this.#selfPort = Math.max(0, (options.session.selfSlot ?? 1) - 1);
    this.lockstep = new Lockstep({
      transport: options.session.transport,
      selfPort: this.#selfPort,
      latch: options.machine.latches[this.#selfPort]!,
      delayFrames: options.delayFramesOverride ?? 3,
      onStallChange: (stalled, waitingFor) => this.#onStall(stalled, waitingFor),
      peerTimeoutMs: options.peerTimeoutMs,
      onPeerTimeout: (ports, stalledMs) => this.#onPeerTimeout(ports, stalledMs),
      onDesync: (frame, otherPort, mine, theirs) => this.#onDesync(frame, otherPort, mine, theirs),
    });
    this.#readyPorts.add(this.#selfPort);
  }

  get phase(): NetplayStatus['phase'] {
    return this.#phase;
  }
  get resyncs(): number {
    return this.#resyncs;
  }
  get selfPort(): number {
    return this.#selfPort;
  }

  /** Candidate-pair RTT per emulator port, refreshed by refreshLinkStats(). */
  get rttByPort(): Record<number, number | null> {
    return this.#rttByPort;
  }

  /**
   * getStats() is comparatively expensive and its numbers move slowly, so this
   * is polled about once a second rather than on the HUD's own cadence.
   */
  async refreshLinkStats(): Promise<void> {
    const stats = await this.#session.peerStats();
    const out: Record<number, number | null> = {};
    for (const [peerId, s] of Object.entries(stats)) {
      const port = this.#session.portForPeer(peerId);
      if (port !== null) out[port] = s?.rttMs ?? null;
    }
    this.#rttByPort = out;
  }

  onStatus(cb: (s: NetplayStatus) => void): void {
    this.#onStatus = cb;
  }

  attach(): void {
    const t = this.#session.transport;
    this.#unsubscribes.push(
      t.onInput((from, bytes) => this.#onWire(from, bytes)),
      t.onControl((from, msg) => this.#onControl(from, msg)),
      t.onPeerLeave((peerId, reason) => this.#onPeerLeave(peerId, reason)),
      this.#machine.frameAdvanced.on((frame) => this.#onFrameAdvanced(frame)),
    );
  }

  /**
   * Once a second, checksum our own simulation and publish it.
   *
   * Lockstep is only correct while every peer really does compute the same
   * frame. Nothing enforces that — it is a property we believe holds, and a
   * silent violation turns one game into two without any error anywhere. This
   * is the thing that would tell us.
   */
  #onFrameAdvanced(frame: number): void {
    if (!this.lockstep.running || frame % CHECKSUM_INTERVAL_FRAMES !== 0) return;
    this.lockstep.publishChecksum(frame, hashState(this.#machine.core.serialize()));
  }

  #onDesync(frame: number, otherPort: number, mine: number, theirs: number): void {
    this.#log.error('DESYNC: a peer computed a different frame', {
      frame,
      otherPort,
      mine: mine.toString(16),
      theirs: theirs.toString(16),
    });
    if (this.#session.role === 'host') {
      // A resync is also the repair: everyone restores from one state again.
      this.#maybeResync(`desync at frame ${frame} with port ${otherPort}`);
    } else {
      this.#session.transport.sendControl({
        t: 'desync',
        frame,
        myPort: this.#selfPort,
        otherPort,
      });
    }
  }

  detach(): void {
    for (const un of this.#unsubscribes) un();
    this.#unsubscribes = [];
    this.lockstep.stop();
    this.#machine.setDriver(null);
  }

  /** This peer's emulator is up with a ROM loaded. */
  announceReady(): void {
    this.#selfPort = Math.max(0, (this.#session.selfSlot ?? 1) - 1);
    this.#readyPorts.add(this.#selfPort);
    if (this.#session.role === 'host') {
      this.#maybeResync('host ready');
    } else {
      this.#session.transport.sendControl({ t: 'ready', port: this.#selfPort });
      this.#setStatus('syncing', 'told the host we are ready, waiting for a state');
    }
  }

  // -- wire ----------------------------------------------------------------

  #onWire(from: PeerId, bytes: Uint8Array): void {
    const kind = bytes[0];
    if (kind === WireKind.Input) {
      this.lockstep.acceptInput(from, bytes);
      return;
    }
    if (kind === WireKind.StateChunk) {
      const chunk = decodeStateChunk(bytes);
      if (!chunk) return;
      const complete = this.#assembler.accept(chunk);
      const { have, want } = this.#assembler.progress;
      if (!complete) {
        this.#setStatus('syncing', `receiving state ${have}/${want}`);
        return;
      }
      this.#orphanState.set(chunk.transferId, complete);
      this.#tryApply();
      return;
    }
  }

  #onControl(from: PeerId, msg: ControlMessage): void {
    switch (msg.t) {
      case 'ready': {
        if (this.#session.role !== 'host') return;
        this.#readyPorts.add(msg.port);
        this.#log.net('peer emulator ready', { peerId: from, port: msg.port });
        this.#maybeResync(`port ${msg.port} joined`);
        return;
      }
      case 'begin': {
        if (this.#session.role === 'host') return;
        this.#log.net('resync incoming', { frame: msg.frame, ports: msg.ports, reason: msg.reason });
        this.#machine.stop();
        this.#pendingBegin = {
          frame: msg.frame,
          ports: msg.ports,
          delayFrames: msg.delayFrames,
          transferId: msg.transferId,
        };
        this.#setStatus('syncing', `waiting for the state at frame ${msg.frame}`);
        this.#tryApply();
        return;
      }
      case 'desync': {
        if (this.#session.role !== 'host') return;
        this.#log.error('a guest reported a desync, resyncing everyone', {
          peerId: from,
          frame: msg.frame,
          between: [msg.myPort, msg.otherPort],
        });
        this.#maybeResync(`desync reported at frame ${msg.frame}`);
        return;
      }
      case 'begun': {
        this.#log.net('peer restored', { peerId: from, frame: msg.frame, port: msg.port });
        return;
      }
      default:
        return;
    }
  }

  #onPeerLeave(peerId: PeerId, reason: string): void {
    // Whoever left takes their port with them, immediately. Remaining peers must
    // not sit waiting for input that is never coming.
    const port = this.#session.portForPeer(peerId);
    if (port !== null) this.#readyPorts.delete(port);
    this.#log.warn('peer dropped out', { peerId, port, reason });
    if (this.#session.role === 'host') {
      this.#maybeResync(`port ${port ?? '?'} disconnected`);
    } else if (this.#readyPorts.size <= 1) {
      // The host is gone. Nothing can resync us, so fall back to solo rather
      // than freezing on a frame we can never complete.
      this.lockstep.stop();
      this.#machine.setDriver(null);
      this.#setStatus('solo', 'host disconnected, continuing solo');
      void this.#machine.start();
    }
  }

  // -- resync (host only) ---------------------------------------------------

  #maybeResync(reason: string): void {
    if (this.#session.role !== 'host') return;
    const ports = [...this.#readyPorts].sort((a, b) => a - b);
    if (ports.length <= 1) {
      // Alone again. Free-run rather than lockstepping with ourselves.
      this.lockstep.stop();
      this.#machine.setDriver(null);
      this.#setStatus('solo', reason);
      if (!this.#machine.running && this.#machine.core.loaded) void this.#machine.start();
      return;
    }
    void this.#resync(ports, reason);
  }

  async #resync(ports: number[], reason: string): Promise<void> {
    const machine = this.#machine;
    if (!machine.core.loaded) return;

    // Freeze so the frame we serialize is exactly the frame everyone restarts
    // from. Any advance between serialize and begin would desync the guests.
    machine.stop();
    const frame = machine.frame;
    const state = machine.core.serialize();
    const transferId = this.#transferId++;
    const delayFrames = await this.#chooseDelay();

    this.#log.info('resyncing everyone', { frame, ports, reason, stateBytes: state.length, delayFrames });
    this.#setStatus('syncing', `sending state to ${ports.length - 1} peer(s)`);

    this.#session.transport.sendControl({
      t: 'begin',
      frame,
      transferId,
      ports,
      delayFrames,
      reason,
    });
    for (const chunk of chunkState(transferId, state)) {
      this.#session.transport.sendInput(chunk);
    }

    this.#resyncs += 1;
    this.lockstep.begin(frame, ports, delayFrames);
    machine.setDriver(this.lockstep, frame);
    this.#setStatus('lockstep', `frame ${frame}, ports ${ports.join(',')}`);
    await machine.start();
  }

  /**
   * Input delay has to cover the worst one-way trip, or every peer stalls on
   * every frame. Derived from the measured candidate-pair RTT unless pinned.
   */
  async #chooseDelay(): Promise<number> {
    if (this.#delayOverride !== null) return this.#delayOverride;
    const stats = await this.#session.peerStats();
    let worstRttMs = 0;
    for (const s of Object.values(stats)) {
      if (s?.rttMs != null) worstRttMs = Math.max(worstRttMs, s.rttMs);
    }
    const frameMs = 1000 / (this.#machine.core.fps || 59.63);
    const frames = Math.ceil(worstRttMs / 2 / frameMs) + JITTER_MARGIN_FRAMES;
    return Math.min(MAX_DELAY_FRAMES, Math.max(MIN_DELAY_FRAMES, frames));
  }

  // -- guest side -----------------------------------------------------------

  /** Applies as soon as both the `begin` and the full state are in hand. */
  #tryApply(): void {
    const pending = this.#pendingBegin;
    if (!pending) return;
    const state = this.#orphanState.get(pending.transferId);
    if (!state) return;
    this.#orphanState.clear();
    this.#applyState(state, pending);
  }

  #applyState(
    state: Uint8Array,
    pending: { frame: number; ports: number[]; delayFrames: number },
  ): void {
    this.#pendingBegin = null;
    this.#machine.stop();
    if (!this.#machine.core.unserialize(state)) {
      this.#log.error('could not restore the host state', { bytes: state.length });
      this.#setStatus('solo', 'state restore failed');
      return;
    }
    this.#log.info('restored host state', {
      frame: pending.frame,
      ports: pending.ports,
      bytes: state.length,
    });
    this.lockstep.begin(pending.frame, pending.ports, pending.delayFrames);
    this.#machine.setDriver(this.lockstep, pending.frame);
    this.#setStatus('lockstep', `frame ${pending.frame}, ports ${pending.ports.join(',')}`);
    void this.#machine.start();
    this.#session.transport.sendControl({
      t: 'begun',
      frame: pending.frame,
      port: this.#selfPort,
    });
  }

  /**
   * A peer has gone silent for longer than we are willing to wait.
   *
   * Whatever the cause — closed tab, dead network, a laptop lid — the answer is
   * the same: drop them and carry on. A lockstep game that waits politely for
   * an absent player is a frozen game.
   */
  #onPeerTimeout(ports: number[], stalledMs: number): void {
    this.#log.warn('peer went silent, dropping it', { ports, stalledMs: Math.round(stalledMs) });
    for (const port of ports) this.#readyPorts.delete(port);

    if (this.#session.role === 'host') {
      this.#maybeResync(`port ${ports.join(',')} timed out`);
      return;
    }
    // A guest cannot re-seat anybody; only the host can. If the host itself is
    // what went quiet, there is nothing left to be in lockstep with.
    if (ports.includes(0)) {
      this.lockstep.stop();
      this.#machine.setDriver(null);
      this.#setStatus('solo', 'host went silent, continuing solo');
      void this.#machine.start();
    }
  }

  #onStall(stalled: boolean, waitingFor: number[]): void {
    if (stalled) {
      this.#setStatus('stalled', `waiting on port ${waitingFor.join(',')}`);
    } else {
      this.#setStatus('lockstep', `frame ${this.#machine.frame}`);
    }
  }

  #setStatus(phase: NetplayStatus['phase'], detail: string): void {
    this.#phase = phase;
    this.#detail = detail;
    this.#onStatus?.({ phase, detail });
  }

  get status(): NetplayStatus {
    return { phase: this.#phase, detail: this.#detail };
  }
}

/**
 * FNV-1a over a stride of the savestate.
 *
 * Every seventh byte of 269KB is ~38K samples — more than enough to catch a
 * divergence, since a desynced emulator differs in far more than one byte, and
 * it keeps the per-second cost negligible.
 */
function hashState(state: Uint8Array): number {
  let h = 2166136261;
  for (let i = 0; i < state.length; i += 7) {
    h ^= state[i] as number;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
