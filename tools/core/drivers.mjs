/**
 * The list of romset names a built core actually contains.
 *
 * FBNeo picks its driver from the file's basename, so `mslug.zip` boots `mslug`
 * and a file named anything else boots nothing. That makes "is this name in the
 * core" the one check that turns FBNeo's silent refusal into a sentence a player
 * can act on — which emulator to switch to, or what to rename the file.
 *
 * Two sources are intersected, because neither alone is right: `driverlist.h` is
 * generated per subset and says exactly which drivers were linked in, but it
 * holds C symbols; the driver sources hold the romset names, but all of them,
 * for every subset. The intersection is this core's names and only those.
 *
 * Run by build.sh. Zero dependencies, like everything else in tools/.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** `DRV\t\tBurnDrvMslug;` — the per-subset list of linked drivers. */
function symbolsFrom(driverlistPath) {
  const out = new Set();
  for (const line of readFileSync(driverlistPath, 'utf8').split('\n')) {
    const m = /^DRV\s+(BurnDrv\w+);/.exec(line.trim());
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * `struct BurnDriver BurnDrvMslug = {\n\t"mslug", NULL, "neogeo", ...`
 *
 * The romset name is the struct's first field. Anchoring on the symbol rather
 * than on which file it lives in means a driver moving between source files
 * cannot quietly drop out of the manifest.
 */
function namesFrom(root) {
  const bySymbol = new Map();
  const scan = (text) => {
    const re = /struct\s+BurnDriver\w*\s+(BurnDrv\w+)\s*=\s*\{\s*"([^"]*)"/g;
    for (let m; (m = re.exec(text)); ) bySymbol.set(m[1], m[2]);
  };
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.cpp')) scan(readFileSync(path, 'utf8'));
    }
  };
  walk(root);
  return bySymbol;
}

const [driverlist, driversDir] = process.argv.slice(2);
if (!driverlist || !driversDir) {
  console.error('usage: drivers.mjs <driverlist.h> <src/burn/drv>');
  process.exit(2);
}

const symbols = symbolsFrom(driverlist);
const names = namesFrom(driversDir);
const linked = [...symbols].map((s) => names.get(s)).filter((n) => typeof n === 'string' && n !== '');
const missing = symbols.size - linked.length;
if (missing > 0) console.error(`warning: ${missing} linked drivers had no romset name`);
process.stdout.write(JSON.stringify([...new Set(linked)].sort()));
console.error(`${linked.length} drivers`);
