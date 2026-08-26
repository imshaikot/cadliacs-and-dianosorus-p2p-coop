/**
 * Binary messages on the unreliable-ish input channel.
 *
 * The channel is unordered but still retransmitted (see ARCHITECTURE.md), so
 * every byte does arrive — just not necessarily in order. Both message kinds
 * below are therefore self-describing and order-independent.
 */
export const WireKind = {
  Input: 0x01,
  StateChunk: 0x02,
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

export function encodeStateChunk(
  transferId: number,
  index: number,
  count: number,
  totalBytes: number,
  payload: Uint8Array,
): Uint8Array {
  const buf = new Uint8Array(STATE_CHUNK_HEADER_BYTES + payload.length);
  const view = new DataView(buf.buffer);
  buf[0] = WireKind.StateChunk;
  view.setUint32(1, transferId >>> 0, true);
  view.setUint16(5, index, true);
  view.setUint16(7, count, true);
  view.setUint32(9, totalBytes >>> 0, true);
  buf.set(payload, STATE_CHUNK_HEADER_BYTES);
  return buf;
}

export function decodeStateChunk(bytes: Uint8Array): StateChunk | null {
  if (bytes.length < STATE_CHUNK_HEADER_BYTES || bytes[0] !== WireKind.StateChunk) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    transferId: view.getUint32(1, true),
    index: view.getUint16(5, true),
    count: view.getUint16(7, true),
    totalBytes: view.getUint32(9, true),
    payload: bytes.subarray(STATE_CHUNK_HEADER_BYTES),
  };
}

/** Splits a savestate into chunks. Order does not matter to the receiver. */
export function* chunkState(transferId: number, state: Uint8Array): Generator<Uint8Array> {
  const count = Math.ceil(state.length / STATE_CHUNK_PAYLOAD);
  for (let i = 0; i < count; i += 1) {
    const start = i * STATE_CHUNK_PAYLOAD;
    yield encodeStateChunk(
      transferId,
      i,
      count,
      state.length,
      state.subarray(start, Math.min(start + STATE_CHUNK_PAYLOAD, state.length)),
    );
  }
}

/** Reassembles chunks that may arrive in any order. */
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
