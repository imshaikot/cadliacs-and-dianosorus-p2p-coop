/**
 * The Neo Geo core is the same `tools/core/shim.c` linked against a different
 * FBNeo subset, so its exports are identical to the CPS one's. The types live
 * once, next to cps12, rather than being copied and drifting.
 */
export type { FbneoModuleOptions, FbneoWasm } from './fbneo_cps12.mjs';
export { default } from './fbneo_cps12.mjs';
