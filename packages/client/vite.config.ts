import { defineConfig, loadEnv } from 'vite';

/**
 * Resolved without `node:url` on purpose: the approved dependency list is
 * peerjs + vite + typescript, and pulling in @types/node just to call
 * fileURLToPath would widen it.
 */
const fromHere = (relative: string): string =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname);

const repoRoot = fromHere('../../');
const sharedEntry = fromHere('../shared/src/index.ts');

const truthy = (value: string | undefined): boolean =>
  ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());

export default defineConfig(({ mode, command }) => {
  // .env lives at the repo root so there is one place to point the broker.
  const env = loadEnv(mode, repoRoot, 'VITE_');

  /**
   * Gotcha #7. A threaded WASM core needs SharedArrayBuffer, which needs the
   * page to be cross-origin isolated. That in turn makes every cross-origin
   * subresource require CORP headers, so it is off unless asked for — the plan
   * is a single-threaded FBNeo build that sidesteps the whole problem. Flip
   * VITE_CROSS_ORIGIN_ISOLATION=1 in .env if M1 needs threads.
   *
   * The same two headers must be set by whatever serves the production build.
   * See README.
   */
  const isolate = truthy(env['VITE_CROSS_ORIGIN_ISOLATION']);
  const isolationHeaders: Record<string, string> = isolate
    ? {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      }
    : {};

  /**
   * A development convenience only: the dev server already serves repo-root
   * files over `/@fs`, so whatever you name in VITE_ROM_FILE is reachable from
   * `roms/` with no plugin and no copy, and you skip the file picker on every
   * reload.
   *
   * There is deliberately no default. This player is game-agnostic — the driver
   * is chosen from the file's own name — so guessing a filename here would be
   * both wrong and a statement about which game this project is for. Unset means
   * the picker, which is exactly what a production build always gets.
   *
   * The name also settles which emulator boots: this is the one path with no
   * dropdown on it, so `mslug.zip` has to be enough to mean Neo Geo. See rom.ts.
   */
  const serving = command === 'serve';
  const fromRoms = (name: string): string => (serving && name ? `/@fs${repoRoot}roms/${name}` : '');
  const devRomUrl = fromRoms(env['VITE_ROM_FILE'] ?? '');
  /**
   * Neo Geo drivers boot through a BIOS romset, so the dev shortcut needs two
   * files where CPS needs one. Unset is right for CPS and for anyone who has
   * merged the BIOS into their game zip.
   */
  const devRomBiosUrl = fromRoms(env['VITE_ROM_BIOS_FILE'] ?? '');

  return {
    envDir: repoRoot,
    define: {
      __DEV_ROM_URL__: JSON.stringify(devRomUrl),
      __DEV_ROM_BIOS_URL__: JSON.stringify(devRomBiosUrl),
    },
    // The shared package is consumed as TypeScript source, not as a build
    // artifact: one less build step, and edits hot-reload.
    resolve: { alias: { '@retro/shared': sharedEntry } },
    optimizeDeps: { exclude: ['@retro/shared'] },
    server: {
      port: 5173,
      // Fail loudly rather than silently shifting port, so the URL you hand a
      // second player is always the URL that is actually serving.
      strictPort: true,
      headers: isolationHeaders,
      fs: { allow: [repoRoot] },
    },
    preview: { headers: isolationHeaders },
    build: { target: 'es2022', sourcemap: true },
  };
});
