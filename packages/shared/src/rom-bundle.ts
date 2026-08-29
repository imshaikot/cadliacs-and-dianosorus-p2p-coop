/**
 * One transfer, several files.
 *
 * A CPS game is a single zip. A Neo Geo game is that zip *and* `neogeo.zip`,
 * the BIOS every SNK driver boots through — FBNeo looks for it beside the game
 * and refuses the game without it. So the thing a room shares stopped being "a
 * file" and became "the files this driver needs".
 *
 * The obvious implementation — two offers, two transfers, in order — would put
 * sequencing into `RomShare`, which currently has none: one offer, one buffer,
 * one fingerprint, one arrival. Concatenating instead keeps every one of those
 * singular. The bundle is what gets hashed, so a half-sent Neo Geo set fails
 * the same fingerprint check a corrupted CPS zip does, rather than arriving as
 * a game with no BIOS and failing much later as a mystery.
 *
 * The first file is the one whose basename picks the driver. The rest are
 * written beside it and never loaded directly.
 */

export interface RomFile {
  name: string;
  bytes: Uint8Array;
}

/** 'R','B' — enough to reject a stray savestate without pretending to be a checksum. */
const MAGIC0 = 0x52;
const MAGIC1 = 0x42;
const VERSION = 1;
const HEADER_BYTES = 4;

/** A game plus its BIOS is two. Eight is room to be wrong without being a DoS. */
export const MAX_BUNDLE_FILES = 8;
const MAX_NAME_BYTES = 255;

export function encodeRomBundle(files: readonly RomFile[]): Uint8Array {
  if (files.length === 0 || files.length > MAX_BUNDLE_FILES) {
    throw new Error(`a bundle holds 1..${MAX_BUNDLE_FILES} files, not ${files.length}`);
  }
  const encoder = new TextEncoder();
  const names = files.map((f) => {
    const name = encoder.encode(f.name);
    if (name.length === 0 || name.length > MAX_NAME_BYTES) {
      throw new Error(`file name is ${name.length} bytes, which will not fit a bundle`);
    }
    return name;
  });

  let total = HEADER_BYTES;
  for (let i = 0; i < files.length; i += 1) {
    total += 2 + (names[i] as Uint8Array).length + 4 + (files[i] as RomFile).bytes.length;
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  out[2] = VERSION;
  out[3] = files.length;
  let at = HEADER_BYTES;
  for (let i = 0; i < files.length; i += 1) {
    const name = names[i] as Uint8Array;
    const bytes = (files[i] as RomFile).bytes;
    view.setUint16(at, name.length, true);
    at += 2;
    out.set(name, at);
    at += name.length;
    view.setUint32(at, bytes.length, true);
    at += 4;
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}

/**
 * Never throws. A peer controls these bytes, and a malformed bundle has to fail
 * as a rejected message rather than as an exception halfway through a frame.
 */
export function decodeRomBundle(bytes: Uint8Array): RomFile[] | null {
  if (bytes.length < HEADER_BYTES) return null;
  if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1 || bytes[2] !== VERSION) return null;
  const count = bytes[3] ?? 0;
  if (count < 1 || count > MAX_BUNDLE_FILES) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const out: RomFile[] = [];
  let at = HEADER_BYTES;
  for (let i = 0; i < count; i += 1) {
    if (at + 2 > bytes.length) return null;
    const nameLength = view.getUint16(at, true);
    at += 2;
    if (nameLength === 0 || at + nameLength + 4 > bytes.length) return null;
    const name = decoder.decode(bytes.subarray(at, at + nameLength));
    at += nameLength;
    const byteLength = view.getUint32(at, true);
    at += 4;
    if (at + byteLength > bytes.length) return null;
    // A copy, not a subarray: these outlive the assembler's buffer, and a view
    // into a multi-megabyte transfer would pin the whole thing in memory.
    out.push({ name, bytes: bytes.slice(at, at + byteLength) });
    at += byteLength;
  }
  // Trailing bytes mean this is not the message we think it is.
  return at === bytes.length ? out : null;
}
