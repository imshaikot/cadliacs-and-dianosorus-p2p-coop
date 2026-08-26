/**
 * Getting the ROM into the browser.
 *
 * Nothing here fetches from the internet, and there is no code path that could.
 * In development Vite already serves files from the repo root over `/@fs`, so
 * the `roms/dino.zip` the project brief asks for is readable with no plugin and
 * no copy. A production build has no such path, so the user picks the file.
 */

export interface RomSource {
  name: string;
  bytes: Uint8Array;
  origin: 'dev-server' | 'file';
}

/** Injected by vite.config.ts; empty string in a production build. */
declare const __DEV_ROM_URL__: string;

export function devRomUrl(): string {
  return typeof __DEV_ROM_URL__ === 'string' ? __DEV_ROM_URL__ : '';
}

export async function loadRomFromDevServer(): Promise<RomSource | null> {
  const url = devRomUrl();
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!looksLikeZip(bytes)) return null;
    return { name: url.split('/').pop() ?? 'dino.zip', bytes, origin: 'dev-server' };
  } catch {
    return null;
  }
}

export async function loadRomFromFile(file: File): Promise<RomSource> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLikeZip(bytes)) {
    throw new Error(`${file.name} is not a zip archive`);
  }
  return { name: file.name, bytes, origin: 'file' };
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}
