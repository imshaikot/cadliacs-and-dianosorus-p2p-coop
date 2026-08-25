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

/** Bumped whenever control or input framing changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/** Player 1 is always the host (it owns the emulator). Guests fill 2 and 3. */
export type PlayerSlot = 1 | 2 | 3;
export const MAX_PLAYERS = 3;
export const GUEST_SLOTS: readonly PlayerSlot[] = [2, 3];

export type ControlMessage =
  /** guest -> host, first thing sent on the control channel. */
  | { t: 'hello'; protocol: number; label: string }
  /** host -> guest, in reply to hello. `slot` is the emulator port to drive. */
  | { t: 'welcome'; protocol: number; slot: PlayerSlot; label: string }
  /** host -> guest, when the room is full or the protocol does not match. */
  | { t: 'reject'; reason: string }
  /** either direction, on deliberate teardown. */
  | { t: 'bye'; reason: string }
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
    case 'welcome':
    case 'reject':
    case 'bye':
    case 'chat':
      return parsed as ControlMessage;
    default:
      return null;
  }
}
