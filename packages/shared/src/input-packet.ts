/**
 * Binary messages on the unreliable-ish input channel.
 *
 * The channel is unordered but still retransmitted — see the `verdict` line the
 * transport logs when a channel opens — so every byte does arrive, just not
 * necessarily in order. Both message kinds below are therefore self-describing
 * and order-independent.
 */
export const WireKind = {
  Input: 0x01,
  StateChunk: 0x02,
  Checksum: 0x03,
  RomChunk: 0x04,
} as const;

export const INPUT_HEADER_BYTES = 7;
/**
 * How many frames of input history ride along in every packet.
 *
 * Gotcha #5: input is NEVER retransmitted at the application layer. A lost
 * packet is repaired by the next one ~16ms later, because that one still
 * carries the frame the lost one had. Twelve frames is 200ms of cover for
 * 24 bytes, which is free at this rate.
 */
export const INPUT_HISTORY_FRAMES = 12;

export interface InputPacket {
  port: number;
  /** Newest frame in this packet. Older frames follow, descending. */
  baseFrame: number;
  /** masks[i] is the mask for frame `baseFrame - i`. */
  masks: Uint16Array;
}

export function encodeInput(port: number, baseFrame: number, masks: Uint16Array): Uint8Array {
  const count = Math.min(masks.length, 255);
  const buf = new Uint8Array(INPUT_HEADER_BYTES + count * 2);
  const view = new DataView(buf.buffer);
  buf[0] = WireKind.Input;
  buf[1] = port & 0xff;
  view.setUint32(2, baseFrame >>> 0, true);
  buf[6] = count;
  for (let i = 0; i < count; i += 1) view.setUint16(INPUT_HEADER_BYTES + i * 2, masks[i] ?? 0, true);
  return buf;
}

export function decodeInput(bytes: Uint8Array): InputPacket | null {
  if (bytes.length < INPUT_HEADER_BYTES || bytes[0] !== WireKind.Input) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes[6] ?? 0;
  if (bytes.length < INPUT_HEADER_BYTES + count * 2) return null;
  const masks = new Uint16Array(count);
  for (let i = 0; i < count; i += 1) masks[i] = view.getUint16(INPUT_HEADER_BYTES + i * 2, true);
  return { port: bytes[1] ?? 0, baseFrame: view.getUint32(2, true), masks };
}

export const STATE_CHUNK_HEADER_BYTES = 13;
/** Comfortably under the SCTP message limit, and small enough to interleave. */
export const STATE_CHUNK_PAYLOAD = 16 * 1024;

export interface StateChunk {
  transferId: number;
  index: number;
  count: number;
  totalBytes: number;
  payload: Uint8Array;
}

/**
 * One chunk format, two payloads.
 *
 * Savestates and game files are the same problem — a few hundred kilobytes to a
 * few megabytes of opaque bytes that has to survive an unordered channel — so
 * they share a header and differ only in the leading kind byte. `count` is a
 * uint16, which caps a transfer at 65535 chunks, or a gigabyte.
 */
function encodeChunk(
  kind: number,
  transferId: number,
  index: number,
  count: number,
  totalBytes: number,
  payload: Uint8Array,
): Uint8Array {
  const buf = new Uint8Array(STATE_CHUNK_HEADER_BYTES + payload.length);
  const view = new DataView(buf.buffer);
  buf[0] = kind;
  view.setUint32(1, transferId >>> 0, true);
  view.setUint16(5, index, true);
  view.setUint16(7, count, true);
  view.setUint32(9, totalBytes >>> 0, true);
  buf.set(payload, STATE_CHUNK_HEADER_BYTES);
  return buf;
}

function decodeChunk(kind: number, bytes: Uint8Array): StateChunk | null {
  if (bytes.length < STATE_CHUNK_HEADER_BYTES || bytes[0] !== kind) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    transferId: view.getUint32(1, true),
    index: view.getUint16(5, true),
    count: view.getUint16(7, true),
    totalBytes: view.getUint32(9, true),
    payload: bytes.subarray(STATE_CHUNK_HEADER_BYTES),
  };
}

function* chunkBytes(kind: number, transferId: number, data: Uint8Array): Generator<Uint8Array> {
  const count = Math.ceil(data.length / STATE_CHUNK_PAYLOAD);
  for (let i = 0; i < count; i += 1) {
    const start = i * STATE_CHUNK_PAYLOAD;
    yield encodeChunk(
      kind,
      transferId,
      i,
      count,
      data.length,
      data.subarray(start, Math.min(start + STATE_CHUNK_PAYLOAD, data.length)),
    );
  }
}

export const encodeStateChunk = (
  transferId: number,
  index: number,
  count: number,
  totalBytes: number,
  payload: Uint8Array,
): Uint8Array => encodeChunk(WireKind.StateChunk, transferId, index, count, totalBytes, payload);

export const decodeStateChunk = (bytes: Uint8Array): StateChunk | null =>
  decodeChunk(WireKind.StateChunk, bytes);

/** Splits a savestate into chunks. Order does not matter to the receiver. */
export const chunkState = (transferId: number, state: Uint8Array): Generator<Uint8Array> =>
  chunkBytes(WireKind.StateChunk, transferId, state);

export const decodeRomChunk = (bytes: Uint8Array): StateChunk | null =>
  decodeChunk(WireKind.RomChunk, bytes);

/** Splits a game file into chunks. Paced by the sender, not by this generator. */
export const chunkRom = (transferId: number, rom: Uint8Array): Generator<Uint8Array> =>
  chunkBytes(WireKind.RomChunk, transferId, rom);

export const CHECKSUM_BYTES = 10;

export interface ChecksumMessage {
  frame: number;
  port: number;
  hash: number;
}

/**
 * A periodic "here is what my simulation looks like at frame N".
 *
 * Lockstep is only correct as long as every peer really does compute identical
 * frames. If that ever stops being true the game does not crash — it quietly
 * becomes two different games, which is far worse. Exchanging a cheap checksum
 * once a second turns a silent divergence into a reported one.
 */
export function encodeChecksum(frame: number, port: number, hash: number): Uint8Array {
  const buf = new Uint8Array(CHECKSUM_BYTES);
  const view = new DataView(buf.buffer);
  buf[0] = WireKind.Checksum;
  buf[1] = port & 0xff;
  view.setUint32(2, frame >>> 0, true);
  view.setUint32(6, hash >>> 0, true);
  return buf;
}

export function decodeChecksum(bytes: Uint8Array): ChecksumMessage | null {
  if (bytes.length < CHECKSUM_BYTES || bytes[0] !== WireKind.Checksum) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { port: bytes[1] ?? 0, frame: view.getUint32(2, true), hash: view.getUint32(6, true) };
}

/**
 * Reassembles a chunked transfer, whatever kind it carries.
 *
 * It holds one transfer at a time: a chunk with a new transferId abandons the
 * previous buffer, which is right for savestates (a newer resync supersedes an
 * older one) and right for game files (there is only ever one in flight).
 *
 * It deliberately does not ask for missing chunks. Both channels retransmit in
 * practice — see the `verdict` line the transport logs — so a chunk that never
 * arrives means the peer is gone, and that is the timeout's problem, not this
 * class's. Callers that care watch `progress` and give up.
 */
export class StateAssembler {
  #transferId = -1;
  #buffer: Uint8Array | null = null;
  #seen = new Set<number>();
  #count = 0;

  accept(chunk: StateChunk): Uint8Array | null {
    if (chunk.transferId !== this.#transferId) {
      this.#transferId = chunk.transferId;
      this.#buffer = new Uint8Array(chunk.totalBytes);
      this.#seen.clear();
      this.#count = chunk.count;
    }
    if (!this.#buffer || this.#seen.has(chunk.index)) return null;
    this.#seen.add(chunk.index);
    this.#buffer.set(chunk.payload, chunk.index * STATE_CHUNK_PAYLOAD);
    if (this.#seen.size !== this.#count) return null;
    const complete = this.#buffer;
    this.#buffer = null;
    return complete;
  }

  get progress(): { have: number; want: number } {
    return { have: this.#seen.size, want: this.#count };
  }
}
