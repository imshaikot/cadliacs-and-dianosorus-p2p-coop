/**
 * The ten avatars a player can pick.
 *
 * Only the *id* lives here, because only the id crosses the wire. The drawings
 * are inline SVG in the client (`packages/client/src/avatars.ts`) — shared code
 * has no business knowing about `<path>`.
 *
 * Duplicates are allowed: two players may pick the same silhouette. The name
 * tells them apart, and negotiating uniqueness would cost a round trip during
 * the handshake to solve a problem nobody has.
 */
export const AVATAR_IDS = [
  'raptor',
  'trike',
  'sauropod',
  'pterosaur',
  'ankylosaur',
  'cadillac',
  'cutlass',
  'cycad',
  'skull',
  'volcano',
] as const;

export type AvatarId = (typeof AVATAR_IDS)[number];

export const DEFAULT_AVATAR: AvatarId = 'raptor';

/** A peer controls this string, so every inbound avatar goes through here. */
export function isAvatarId(value: unknown): value is AvatarId {
  return typeof value === 'string' && (AVATAR_IDS as readonly string[]).includes(value);
}

export function coerceAvatar(value: unknown): AvatarId {
  return isAvatarId(value) ? value : DEFAULT_AVATAR;
}
