/**
 * Enforces the one architectural rule that matters: nothing may import `peerjs`
 * except the single adapter that implements the Transport interface. V2's
 * rollback netcode should be a one-file swap, and it only stays that way if
 * this stays true.
 *
 * Zero dependencies on purpose.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ALLOWED = 'packages/shared/src/peerjs-transport.ts';
const IMPORT_RE = /(?:^|[^\w])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) yield full;
  }
}

const offenders = [];
for (const file of walk(join(ROOT, 'packages'))) {
  const rel = relative(ROOT, file).split(sep).join('/');
  if (rel === ALLOWED) continue;
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec === 'peerjs' || spec?.startsWith('peerjs/')) offenders.push(rel);
  }
}

if (offenders.length > 0) {
  console.error('Layering violation: `peerjs` may only be imported by ' + ALLOWED);
  for (const file of [...new Set(offenders)]) console.error('  ' + file);
  process.exit(1);
}
console.log('layering ok: peerjs is imported only by ' + ALLOWED);
