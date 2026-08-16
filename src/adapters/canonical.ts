// The canonical adapter: reads the authoritative, highest-precedence
// `platform-map.json` and maps its declared `units[]` into PartialUnits. A
// THIN delegate over config.ts, which owns reading/parsing/validation and the
// ONLY throw an adapter may propagate (MalformedConfigError); config-level
// facts (name/ignore/overrides + the promotion-gate flag) travel back to
// map() via the typed `canonical` side-channel. Every declared path runs
// through resolveWithinRoot; a path escaping the platform root is DROPPED
// with a UNIT_PATH_ESCAPE diagnostic, never followed.

import { readPlatformFile } from "../config.js";
import { resolveWithinRoot } from "../internal/path-guard.js";
import type { Diagnostic, PlatformMapConfig } from "../types.js";
import type { AdapterContext, AdapterResult, PartialUnit } from "./index.js";

/**
 * Reads `<root>/platform-map.json` via the discriminated readPlatformFile
 * (MalformedConfigError propagates) and maps declared units into
 * `kind:"repo"` PartialUnits. kind "definition" builds PartialUnits from
 * members (path defaults to the member name, the child-dir convention) with
 * side-channel { name, ignore, declaredUnits: true }, so merge()'s promotion
 * gate flags unlisted children as UNCONFIGURED_SIBLING; kind "config" and
 * "marker" behave as the rung-1/2 config. Absent file -> empty result.
 */
export function canonicalAdapter(
  root: string,
  _ctx: AdapterContext,
): AdapterResult {
  // A present-but-broken canonical config is a hard error, unlike every
  // other adapter source.
  const file = readPlatformFile(root);
  if (file.kind === "absent") {
    // Absent config is fine. No side-channel: declaredUnits defaults false.
    return { partialUnits: [], edges: [], diagnostics: [] };
  }

  if (file.kind === "definition") {
    const partialUnits: PartialUnit[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const m of file.definition.members) {
      const guard = resolveWithinRoot(root, m.path ?? m.name);
      if (!guard.ok) {
        diagnostics.push(guard.diagnostic);
        continue;
      }
      partialUnits.push({
        name: m.name,
        path: guard.relative,
        kind: "repo",
        source: "canonical",
      });
    }
    return {
      partialUnits,
      edges: [],
      diagnostics,
      canonical: {
        name: file.definition.name,
        ignore: file.definition.ignore,
        // `overrides` is forbidden alongside `members`, so never present.
        // members is non-empty by validation, so declaredUnits is always true.
        declaredUnits: true,
      },
    };
  }

  // "config" and "marker" alike: the rung-1/2 config drives the behavior below.
  const config: PlatformMapConfig = file.config;

  const partialUnits: PartialUnit[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const u of config.units ?? []) {
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
    // Declared ref wins; ref-less units are left for map()'s per-unit probe.
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
