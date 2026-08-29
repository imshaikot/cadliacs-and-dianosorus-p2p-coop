/**
 * Wire protocol.
 *
 * Two logically separate streams travel between peers:
 *
 *   control  — low rate, must arrive, order matters. Slot assignment, joins,
 *              goodbyes. JSON, because it is low rate and being able to read it
 *              in the devtools network pane is worth more than the bytes.
 *   input    — high rate (once per emulator frame), tiny, self-healing. Raw
 *              bytes, no envelope. See `sendInput` on Transport.
 *
 * They ride on two different data channels with different reliability settings.
 * See PeerJsTransport.
 */

/**
 * Bumped whenever control or input framing changes incompatibly.
 *
 * v2 added the identity fields (`label` gained a companion `avatar`) and the
 * `voice` message. Strictly speaking a v1 peer could ignore both and still
 * play — but it would show up nameless, with a default avatar, unable to be
 * heard. The clean rejection the version check already produces beats that.
 *
 * v3 added the room's `capacity` to `welcome` and the `rom-*` messages. A v2
 * peer would count the lobby to the wrong number and could neither offer a game
 * file nor be told the host's fingerprint, so again: reject, do not limp.
 *
 * v4 added the room's emulated hardware — `system` on `welcome` and `rom-offer`,
 * plus the `system` message the host sends when it changes its mind. A v3 peer
 * would assume CPS and boot the wrong core against Neo Geo bytes, which reads
 * as a corrupt romset rather than as a version problem. Reject.
 */
export const PROTOCOL_VERSION = 4;

/** Player 1 is always the host (it owns the emulator). Guests fill 2 and 3. */
export type PlayerSlot = 1 | 2 | 3;

/**
 * The hard ceiling, which sizes the timeline and lockstep buffers.
 *
 * A room's *capacity* is a separate thing the host picks when it opens the room,
 * and is never larger than this. The distinction matters: capacity is a social
 * choice ("just the two of us"), MAX_PLAYERS is what the arrays were allocated
 * for, and conflating them would let a roster message resize a Uint16Array.
 */
export const MAX_PLAYERS = 3;
export const GUEST_SLOTS: readonly PlayerSlot[] = [2, 3];

/** What the host may choose. Presets, not free input — see coerceCapacity. */
export const CAPACITY_CHOICES: readonly number[] = [2, 3];
export const DEFAULT_CAPACITY = 3;

/**
 * A remote machine controls this number, so it goes through here before it is
 * allowed anywhere near a slot allocation.
 */
export function coerceCapacity(value: unknown): number {
  return typeof value === 'number' && CAPACITY_CHOICES.includes(value) ? value : DEFAULT_CAPACITY;
}

export type ControlMessage =
  /** guest -> host, first thing sent on the control channel. */
  | { t: 'hello'; protocol: number; label: string; avatar: string }
  /**
   * host -> guest, in reply to hello. `slot` is the emulator port to drive,
   * `capacity` is how many the host opened the room for — so a guest can show
   * "2 of 2" rather than always counting up to MAX_PLAYERS — and `system` is
   * the hardware the host has selected, so the guest loads that core once
   * instead of loading CPS and swapping when the offer lands.
   */
  | {
      t: 'welcome';
      protocol: number;
      slot: PlayerSlot;
      label: string;
      avatar: string;
      capacity: number;
      system: string;
    }
  /** host -> guest, when the room is full or the protocol does not match. */
  | { t: 'reject'; reason: string }
  /** either direction, on deliberate teardown. */
  | { t: 'bye'; reason: string }
  /**
   * host -> everyone: the full membership of the room.
   *
   * Guests cannot discover each other through the broker — they only ever knew
   * the host's ID — so the host introduces them. Sent on every change.
   */
  | {
      t: 'roster';
      players: Array<{ peerId: string; slot: PlayerSlot; label: string; avatar: string }>;
    }
  /**
   * any -> everyone: my microphone just went live, or just went quiet.
   *
   * Deliberately NOT part of the roster. The roster is host-authored, so a
   * guest's toggle would have to go guest -> host -> everyone; the mesh already
   * gives every peer a control channel to every other peer, so this is one hop
   * and stays clear of the membership machinery entirely.
   */
  | { t: 'voice'; muted: boolean }
  /** guest -> host: my core is up and I have a game file, deal me in. */
  | { t: 'ready'; port: number }
  /**
   * host -> everyone: the emulator I am about to run.
   *
   * Only ever sent before a game is loaded — switching hardware under a running
   * game is not a thing this offers — so a guest that acts on it is always
   * swapping an idle core, never a live one.
   */
  | { t: 'system'; id: string }
  /**
   * host -> guest: I have a game loaded, and here is what it is.
   *
   * `sha256` is the point of this message even when nobody wants the bytes: two
   * peers running different dumps of the same romset diverge, and the desync
   * counter would report it a minute later with no clue why. Comparing the
   * fingerprint at the door turns that into a sentence.
   *
   * `bytes` and the fingerprint describe the *bundle* — the game and anything it
   * needs beside it, a Neo Geo BIOS typically — not the game zip alone. See
   * rom-bundle.ts.
   */
  | { t: 'rom-offer'; name: string; bytes: number; sha256: string; system: string }
  /** guest -> host: I have no game file, send me yours. */
  | { t: 'rom-request' }
  /** host -> guest: I cannot, and this is why. */
  | { t: 'rom-decline'; reason: string }
  /**
   * host -> everyone: the membership of the game is changing.
   *
   * A savestate is on its way over the input channel under `transferId`; when
   * you have it, restore and run lockstep from `frame` with exactly `ports`
   * live. Every membership change — join AND leave — goes through this, so all
   * peers switch port set at the same frame from the same state by
   * construction, rather than each guessing when a departed peer stopped.
   */
  | { t: 'begin'; frame: number; transferId: number; ports: number[]; delayFrames: number; reason: string }
  /** any -> host: my simulation disagrees with a peer's at this frame. */
  | { t: 'desync'; frame: number; myPort: number; otherPort: number }
  /** guest -> host: restored and ready to run `frame`. */
  | { t: 'begun'; frame: number; port: number }
  /**
   * Either direction. M0 smoke test: proves the control channel carries
   * arbitrary strings end to end. Kept afterwards as a debug echo.
   */
  | { t: 'chat'; text: string };

export function encodeControl(msg: ControlMessage): string {
  return JSON.stringify(msg);
}

/** Never throws: a malformed control frame from a peer must not kill the host. */
export function decodeControl(raw: unknown): ControlMessage | null {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const t = (parsed as { t?: unknown }).t;
  if (typeof t !== 'string') return null;
  switch (t) {
    case 'hello':
    case 'roster':
    case 'welcome':
    case 'reject':
    case 'bye':
    case 'ready':
    case 'begin':
    case 'begun':
    case 'desync':
    case 'voice':
    case 'system':
    case 'rom-offer':
    case 'rom-request':
    case 'rom-decline':
    case 'chat':
      return parsed as ControlMessage;
    default:
      return null;
  }
}
