/**
 * Getting the game into the browser, and saying something useful when it will
 * not go.
 *
 * Nothing here fetches from the internet, and there is no code path that could.
 * In development Vite already serves files from the repo root over `/@fs`, so
 * whatever you name in VITE_ROM_FILE is readable from `roms/` with no plugin and
 * no copy. A production build has no such path, so the user picks the file.
 */
import { coerceSystem } from '@retro/shared';
import type { RomFile, SystemId } from '@retro/shared';

import { driverNameOf, systemForDriver, systemInfo } from './systems.js';

export type { RomFile };

export interface RomSource {
  /** The file whose basename picks the FBNeo driver. */
  name: string;
  bytes: Uint8Array;
  /**
   * Everything else the driver needs sitting in the same directory — in
   * practice the Neo Geo BIOS, which every SNK driver boots through. Written
   * beside the game and never named to the core; FBNeo goes and finds it.
   */
  extras: RomFile[];
  origin: 'dev-server' | 'file' | 'peer';
  /** Which core these bytes are for. Carried, not guessed, once it is known. */
  system: SystemId;
}

/** A pick either becomes a game or becomes a sentence explaining why it did not. */
export type RomPick = { ok: true; rom: RomSource } | { ok: false; message: string };

/** Injected by vite.config.ts; empty string in a production build. */
declare const __DEV_ROM_URL__: string;
declare const __DEV_ROM_BIOS_URL__: string;

export function devRomUrl(): string {
  return typeof __DEV_ROM_URL__ === 'string' ? __DEV_ROM_URL__ : '';
}

function devBiosUrl(): string {
  return typeof __DEV_ROM_BIOS_URL__ === 'string' ? __DEV_ROM_BIOS_URL__ : '';
}

async function fetchZip(url: string): Promise<RomFile | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!looksLikeZip(bytes)) return null;
    return { name: url.split('/').pop() ?? 'game.zip', bytes };
  } catch {
    return null;
  }
}

/**
 * The developer shortcut, which is the one place the system is *inferred*
 * rather than chosen.
 *
 * There is no dropdown on this path — it exists to skip the picker on every
 * reload — so naming `mslug.zip` has to be enough to get the Neo Geo core. The
 * manifests already know which core owns which romset, so it is.
 */
export async function loadRomFromDevServer(): Promise<RomSource | null> {
  const url = devRomUrl();
  if (!url) return null;
  const game = await fetchZip(url);
  if (!game) return null;
  const system = systemForDriver(driverNameOf(game.name))?.id ?? coerceSystem(undefined);
  const biosUrl = devBiosUrl();
  const bios = biosUrl ? await fetchZip(biosUrl) : null;
  return {
    name: game.name,
    bytes: game.bytes,
    extras: bios ? [bios] : [],
    origin: 'dev-server',
    system,
  };
}

/**
 * What the host just picked, checked against the emulator it picked it for.
 *
 * This has to refuse before the bytes reach the core, because **FBNeo's refusal
 * is not a refusal**. `retro_load_game` returns *true* for a zip whose basename
 * matches no driver at all: it then reports the libretro defaults — exactly
 * 60.00Hz and exactly 48000Hz, which no CPS or Neo Geo board runs at — and the
 * frontend cheerfully starts a machine that emulates nothing. Measured, with a
 * 64-byte file named `Metal Slug (1996).zip`: 89 frames "ran", a black canvas,
 * and not one error anywhere.
 *
 * So the driver name is checked here, against the manifest of names the core
 * was actually built with. It is the same rule FBNeo uses — the basename, and
 * nothing else — which is what makes it safe to apply early, and what makes the
 * message it produces worth reading.
 */
export async function pickRom(files: readonly File[], system: SystemId): Promise<RomPick> {
  if (files.length === 0) return { ok: false, message: 'No file was picked.' };
  const info = systemInfo(system);

  const parts: Array<{ name: string; driver: string; bytes: Uint8Array }> = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!looksLikeZip(bytes)) {
      return {
        ok: false,
        message: `${file.name} is not a zip archive. A romset is the zip itself — do not unpack it.`,
      };
    }
    parts.push({ name: file.name, driver: driverNameOf(file.name), bytes });
  }

  const extras = info.bios ? parts.filter((p) => p.driver === info.bios) : [];
  const games = parts.filter((p) => !extras.includes(p));

  if (games.length === 0) {
    return {
      ok: false,
      message: `That is the ${info.label} BIOS on its own. Pick the game zip as well — ${info.examples[0]}, say.`,
    };
  }
  if (games.length > 1) {
    return {
      ok: false,
      message: `Pick one game${info.bios ? `, plus ${info.bios}.zip` : ''}. You picked ${games.length}: ${games
        .map((g) => g.name)
        .join(', ')}.`,
    };
  }

  const game = games[0] as { name: string; driver: string; bytes: Uint8Array };
  const wrong = checkDriver(game.name, system);
  if (wrong) return { ok: false, message: wrong };

  return {
    ok: true,
    rom: {
      name: game.name,
      bytes: game.bytes,
      extras: extras.map((e) => ({ name: e.name, bytes: e.bytes })),
      origin: 'file',
      system,
    },
  };
}

/**
 * The check FBNeo will not do for itself: is this name a driver this core has?
 *
 * Applied to every game whatever its origin — picked, sent by a peer, or handed
 * over by the dev server — because the failure it prevents is silent, and a
 * silent failure on the peer path is a room where one person's screen is black
 * and nobody can say why.
 *
 * Null means the name is fine. It says nothing about the bytes.
 */
export function checkDriver(name: string, system: SystemId): string | null {
  const info = systemInfo(system);
  const driver = driverNameOf(name);
  if (info.drivers.has(driver)) return null;
  const owner = systemForDriver(driver);
  if (owner) {
    return `${name} is a ${owner.label} game (${owner.maker}). Switch the emulator to ${owner.label}, then load it again.`;
  }
  return `The ${info.label} emulator has no driver called “${driver}”. FBNeo reads the driver from the filename, so a romset has to keep its own name — ${info.examples[0]} is ${exampleDriver(system)}.zip.`;
}

/**
 * Why the core said no, once the name has already been cleared.
 *
 * FBNeo's refusal is a bare zero — the reason is somewhere in a log nobody is
 * reading — so this reconstructs it from what is left: whether the BIOS it boots
 * through came with it, and otherwise the set itself.
 */
export function explainRefusal(rom: RomSource): string {
  const info = systemInfo(rom.system);
  const named = checkDriver(rom.name, rom.system);
  if (named) return named;
  if (info.bios && !rom.extras.some((e) => driverNameOf(e.name) === info.bios)) {
    return `FBNeo would not start ${rom.name}. ${info.label} games boot through the ${info.bios}.zip BIOS — pick it alongside the game.`;
  }
  return `FBNeo knows the “${driverNameOf(rom.name)}” driver but would not start this copy. The set is most likely incomplete, or a revision this build does not carry.`;
}

/** A real driver name to show in the "rename it to this" advice. */
function exampleDriver(system: SystemId): string {
  return system === 'neogeo' ? 'mslug' : 'sf2';
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}
