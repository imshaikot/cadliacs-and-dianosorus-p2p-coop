import { DEFAULT_SYSTEM, SYSTEM_IDS } from '@retro/shared';
import type { SystemId } from '@retro/shared';

import cps12Drivers from './core/fbneo_cps12.drivers.json?raw';
import neogeoDrivers from './core/fbneo_neogeo.drivers.json?raw';

/**
 * What differs between one emulated machine and the next.
 *
 * Two FBNeo cores, built from the same shim against different subsets of the
 * same source tree — so everything above this file is identical for both, and
 * everything that is *not* identical is here: what to call it, which games a
 * player would recognise it by, whether it needs a BIOS beside the game, and
 * which romsets it actually contains.
 *
 * Adding a third is: build the subset, drop the three artifacts in `core/`, add
 * an entry here and a member to `SystemId`.
 */

export interface SystemInfo {
  readonly id: SystemId;
  /** The dropdown's option text. Board first — that is what a romset is named for. */
  readonly label: string;
  /** Who made the hardware, for the line under the dropdown. */
  readonly maker: string;
  /**
   * A few games, so the choice can be made by someone who owns a zip and has
   * never heard the phrase "CP System". Titles are facts about hardware, and
   * naming them ships nothing: this player still has no games in it.
   */
  readonly examples: readonly string[];
  /**
   * A romset the driver boots through and cannot run without, which therefore
   * has to travel with the game. Neo Geo has one; CPS has none.
   */
  readonly bios: string | null;
  /** Every romset this core has a driver for. See tools/core/drivers.mjs. */
  readonly drivers: ReadonlySet<string>;
}

/**
 * ~800 and ~700 names, 15 KB of JSON between them, parsed once at startup.
 *
 * Both lists are held even though only one core is ever loaded, and that is the
 * point: knowing that `mslug` is a driver the *other* core has is what turns
 * FBNeo's silent refusal into "that is a Neo Geo game, switch the emulator".
 */
function driverSet(raw: string): ReadonlySet<string> {
  try {
    const names = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []);
  } catch {
    // A broken manifest costs the *quality* of an error message and nothing
    // else — every check that uses it treats "not in the list" as "no opinion".
    return new Set();
  }
}

const SYSTEMS: Readonly<Record<SystemId, SystemInfo>> = {
  cps12: {
    id: 'cps12',
    label: 'CPS-1 / CPS-2',
    maker: 'Capcom',
    examples: [
      'Street Fighter II',
      'Cadillacs and Dinosaurs',
      'Final Fight',
      'Marvel vs. Capcom',
    ],
    bios: null,
    drivers: driverSet(cps12Drivers),
  },
  neogeo: {
    id: 'neogeo',
    label: 'Neo Geo',
    maker: 'SNK',
    examples: ['Metal Slug', 'The King of Fighters', 'Samurai Shodown', 'Garou'],
    bios: 'neogeo',
    drivers: driverSet(neogeoDrivers),
  },
};

export function systemInfo(id: SystemId): SystemInfo {
  return SYSTEMS[id];
}

export const ALL_SYSTEMS: readonly SystemInfo[] = SYSTEM_IDS.map(systemInfo);

/** The one a room runs before anybody chooses. */
export const DEFAULT_SYSTEM_INFO = systemInfo(DEFAULT_SYSTEM);

/**
 * FBNeo picks its driver from the basename and nothing else, so `mslug.zip` is
 * `mslug` and `Metal Slug (1996).zip` is a driver that does not exist. Matching
 * that rule exactly is what lets us answer "will this load" before handing the
 * core a single byte.
 */
export function driverNameOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(/\.[^.]*$/, '').toLowerCase();
}

/** Which of our systems, if any, has a driver by this name. */
export function systemForDriver(driver: string): SystemInfo | null {
  for (const system of ALL_SYSTEMS) {
    if (system.drivers.has(driver)) return system;
  }
  return null;
}
