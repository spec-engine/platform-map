// Role derivation. deriveRole is the standalone pure classifier so consumers
// can recompute or audit a unit's role from signals alone; applyRoles is the
// recursive walker map() uses, with canonical config overrides beating
// derivation at every depth. No I/O. An ABSENT degree signal casts no vote:
// undefined is never treated as 0, so a unit whose degrees were never
// populated cannot be misclassified by the degree-sensitive rules 2 and 4.

import type { Role, Unit, UnitSignals } from "./types.js";

/**
 * Classifies a unit's role from its signals via top-down,
 * first-match rules; pure and replayable without a map() call.
 */
export function deriveRole(s: UnitSignals): Role {
  // Rule 1: deploy/runtime markers -> app.
  if (s.hasDockerfile || s.hasDeployConfig || s.hasStartScript) return "app";
  // Rule 2: something imports it -> library.
  if (s.workspaceInDegree !== undefined && s.workspaceInDegree > 0)
    return "library";
  // Rule 3: exports-shaped, not explicitly public-app-shaped -> library.
  // A `!hasStartScript` clause is omitted: rule 1 already returned "app" for
  // any truthy hasStartScript, so tsc narrows it to `false | undefined` here
  // and the comparison would be provably dead.
  if (s.hasExports === true && s.private !== false) return "library";
  // Rule 4: pure sink (depends on things, nothing depends on it, no exports) -> app.
  if (
    s.workspaceInDegree === 0 &&
    s.workspaceOutDegree !== undefined &&
    s.workspaceOutDegree > 0 &&
    s.hasExports !== true
  )
    return "app";
  // Rule 5: otherwise -> unknown.
  return "unknown";
}

/**
 * Recursively stamps a derived role onto every unit; a canonical
 * `overrides[name].role` beats derivation. Stale override keys were already
 * warned by map(), so an unmatched key is simply inert via optional chaining;
 * the overrides object is never spread, so a `__proto__` key is a harmless miss.
 */
export function applyRoles(
  units: Unit[],
  overrides?: Record<string, { role?: Role }>,
): void {
  for (const u of units) {
    u.role = overrides?.[u.name]?.role ?? deriveRole(u.signals);
    if (u.units.length > 0) applyRoles(u.units, overrides);
  }
}
