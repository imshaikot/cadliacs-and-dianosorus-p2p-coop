/**
 * Room codes.
 *
 * The room code IS the secret. Custom peer IDs on the public PeerJS broker are
 * first-come-first-served and squattable by anyone who can guess the ID, so the
 * code has to be long enough that guessing is hopeless. 12 characters of a
 * 32-symbol alphabet is 60 bits.
 *
 * Alphabet is Crockford base32 (no I, L, O, U) so a code read aloud or copied
 * off a screen is unambiguous.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ROOM_CODE_LENGTH = 12;

/** Peer IDs must start and end alphanumeric; dashes are legal in the middle. */
const PEER_ID_PREFIX = 'dino-v1-';

export function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) {
    // 256 is a whole multiple of 32, so the modulo is unbiased.
    out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

/**
 * Accepts whatever a human pasted or typed and returns the canonical code, or
 * null if it cannot be one. Confusable characters are folded rather than
 * rejected: someone reading a code aloud will say "oh" for zero. U is not
 * folded — it is absent from the alphabet, so a typed U is a genuine mistake
 * and should fail loudly rather than be silently guessed at.
 */
export function normalizeRoomCode(input: string): string | null {
  const folded = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (folded.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of folded) {
    if (!ALPHABET.includes(ch)) return null;
  }
  return folded;
}

/** `ABCD1234EFGH` -> `ABCD-1234-EFGH`. Display only; never sent anywhere. */
export function formatRoomCode(code: string): string {
  return (code.match(/.{1,4}/g) ?? [code]).join('-');
}

/** The broker ID the host registers and the guest dials. */
export function hostPeerId(roomCode: string): string {
  return PEER_ID_PREFIX + roomCode;
}

export function roomCodeFromHostPeerId(peerId: string): string | null {
  if (!peerId.startsWith(PEER_ID_PREFIX)) return null;
  return normalizeRoomCode(peerId.slice(PEER_ID_PREFIX.length));
}
