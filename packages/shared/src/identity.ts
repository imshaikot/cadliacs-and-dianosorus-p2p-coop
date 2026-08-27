/**
 * Player names, on the way in and on the way out.
 *
 * A name is chosen locally and then sent to every other peer, which means it is
 * a string a remote machine controls. It reaches the DOM through `textContent`,
 * so this is not about injection; it is about a peer sending 4 kB of zero-width
 * spaces and wrecking everyone's roster.
 *
 * Both ends run the same function: the sender so the field it typed is the
 * field that travels, the receiver because it cannot trust that it did.
 */
export const MAX_NAME_LENGTH = 16;

/**
 * C0 and C1 controls, the zero-width family, the bidi overrides, and the BOM.
 * Written as a source string rather than a literal so the ranges stay readable
 * as text instead of as the invisible characters they match.
 */
const JUNK = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\uFEFF]',
  'g',
);

/**
 * Drop the junk, flatten runs of whitespace, clamp the length. The second trim
 * matters: clamping can cut mid-word and leave a trailing space.
 *
 * Returns an empty string if nothing survives — callers decide the fallback,
 * because the useful one (`P2`) is only known where the slot is.
 */
export function coerceName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(JUNK, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH).trim();
}

/** True if this is something a player may join under. */
export function isValidName(value: unknown): boolean {
  return coerceName(value).length > 0;
}
