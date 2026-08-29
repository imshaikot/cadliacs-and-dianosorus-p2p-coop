/**
 * Which arcade hardware a room is running.
 *
 * There is one core per hardware family and exactly one of them is ever loaded:
 * the host picks before it loads a game, and everyone else is told. The labels,
 * the example titles and the loaders live client-side in
 * `emulator/systems.ts` — this half is the wire half, and it exists for the
 * same reason `avatars.ts` does: a remote machine controls the string, so both
 * ends have to validate it identically.
 */
export type SystemId = 'cps12' | 'neogeo';

/** Order matters: this is the order the host's dropdown offers them in. */
export const SYSTEM_IDS: readonly SystemId[] = ['cps12', 'neogeo'];

/**
 * What a room runs until the host says otherwise.
 *
 * CPS-1/CPS-2 rather than Neo Geo because it is the one this project was built
 * against, and because it needs no BIOS — a host who picks a file without ever
 * touching the dropdown gets the shorter road.
 */
export const DEFAULT_SYSTEM: SystemId = 'cps12';

export function coerceSystem(value: unknown): SystemId {
  return typeof value === 'string' && (SYSTEM_IDS as readonly string[]).includes(value)
    ? (value as SystemId)
    : DEFAULT_SYSTEM;
}
