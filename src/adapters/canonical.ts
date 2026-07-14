// CFG-01: the canonical adapter — reads the authoritative, highest-precedence
// `platform-map.json` and maps its declared `units[]` into PartialUnits. It is a
// THIN delegate over config.ts: all reading/parsing/validation (and the ONLY
// throw an adapter is allowed to propagate — MalformedConfigError, SEC-01) live
// in readCanonicalConfig; this module just shapes the result and threads the
// config-level facts (name/ignore/overrides + the promotion-gate flag) back to
// map() via the typed `canonical` side-channel.
//
// Deliberately NOT here:
//  - the MODEL-06 ref probe. A declared `ref` is carried through untouched
//    (declared ref wins); a unit WITHOUT a ref is left ref-less for map()'s
//    per-unit loop to probe uniformly across every kind:"repo" unit.
//  - the overrides-references-a-real-unit honesty check. That needs the fully
//    assembled unit set, so it is a map()-level check (Assumption A3).
//  - sorting (serialize.ts is the sole sort site) and edges (Phase 3, always []).
//
// Path safety: every declared `units[].path` runs through resolveWithinRoot — a
// path escaping the platform root is DROPPED with a UNIT_PATH_ESCAPE diagnostic,
// never followed (T-02-17).

import { readCanonicalConfig } from "../config.js";
import { resolveWithinRoot } from "../internal/path-guard.js";
import type { Diagnostic } from "../types.js";
import type { AdapterContext, AdapterResult, PartialUnit } from "./index.js";

/**
 * Reads `<root>/platform-map.json` via readCanonicalConfig (letting
 * MalformedConfigError propagate — the one adapter allowed to throw) and maps
 * declared `units[]` into `kind:"repo"` PartialUnits. Returns an empty result
 * when the config is absent. Surfaces name/ignore/overrides + the
 * `declaredUnits` promotion-gate flag on the `canonical` side-channel.
 */
export function canonicalAdapter(
  root: string,
  _ctx: AdapterContext,
): AdapterResult {
  // MalformedConfigError propagates (SEC-01): a present-but-broken canonical
  // config is a hard error, unlike every other adapter source.
  const config = readCanonicalConfig(root);
  if (config === null) {
    // Absent config = fine (D8). No side-channel: declaredUnits defaults false.
    return { partialUnits: [], edges: [], diagnostics: [] };
  }

  const partialUnits: PartialUnit[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const u of config.units ?? []) {
    // T-02-17: a declared path escaping the platform root is dropped + diagnosed.
    const guard = resolveWithinRoot(root, u.path);
    if (!guard.ok) {
      diagnostics.push(guard.diagnostic);
      continue;
    }
    const pu: PartialUnit = {
      name: u.name,
      path: guard.relative,
      kind: "repo",
      source: "canonical",
    };
    // Declared ref wins (MODEL-06): carry it through so map()'s probe skips it.
    // No ref -> leave undefined so map()'s per-unit loop probes it.
    if (u.ref !== undefined) pu.ref = u.ref;
    partialUnits.push(pu);
  }

  return {
    partialUnits,
    edges: [],
    diagnostics,
    canonical: {
      name: config.name,
      ignore: config.ignore,
      overrides: config.overrides,
      // The gate keys off DECLARED units[] (not surviving count): an all-escaped
      // units[] still declared units, so siblings must not be promoted.
      declaredUnits: (config.units?.length ?? 0) > 0,
    },
  };
}
