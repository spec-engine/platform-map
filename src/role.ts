// MODEL-03/MODEL-04 (+ GRAPH-05 consumer): role derivation. deriveRole is the
// standalone, exported, PURE classifier — a consumer can recompute or audit a
// unit's role from its signals without a full map() call (MODEL-03 replayability).
// applyRoles is the recursive walker map() uses to stamp roles onto the tree,
// with canonical config overrides beating derivation at every depth (MODEL-04).
//
// No I/O (SEC-05): no fs, no child_process, no fetch — pure signals-in, Role-out.
// MODEL-02 honesty: an ABSENT degree signal casts no vote (undefined is never
// treated as 0), so a unit whose degrees were never populated cannot be
// misclassified by the degree-sensitive rules 2 and 4.

import type { Role, Unit, UnitSignals } from "./types.js";

/**
 * Classifies a unit's role from its signals via DESIGN §4's top-down,
 * first-match rules. Pure and exported so consumers can replay/audit the
 * classification without map() (MODEL-03). Explicit `: Role` return type keeps
 * tsdown's isolated-declarations fast dts path honest (CLAUDE.md §4).
 *
 * Absent-signal honesty (MODEL-02): rules 2 and 4 guard `!== undefined` before
 * comparing degrees, so an unpopulated `workspaceInDegree` skips both rather than
 * masquerading as 0.
 */
export function deriveRole(s: UnitSignals): Role {
  // Rule 1: deploy/runtime markers -> app.
  if (s.hasDockerfile || s.hasDeployConfig || s.hasStartScript) return "app";
  // Rule 2: something imports it -> library.
  if (s.workspaceInDegree !== undefined && s.workspaceInDegree > 0)
    return "library";
  // Rule 3: exports-shaped, not explicitly public-app-shaped -> library.
  // NOTE: DESIGN §4 rule 3 reads `hasExports && private !== false … && !hasStartScript`;
  // the "…" ellipsis is interpreted as NO additional hidden clause (operator
  // notified and accepts this reading — see 03-03-PLAN.md / SUMMARY).
  // Rule 1 already returned "app" for any truthy `hasStartScript`, so the DESIGN
  // `&& !hasStartScript` clause is always satisfied here — omitted to keep tsc's
  // control-flow narrowing happy (it types `hasStartScript` as `false | undefined`
  // at this point, making `!== true` a provably-dead comparison).
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
 * Recursively stamps a derived role onto every unit at all depths. A canonical
 * `overrides[name].role` beats derivation (MODEL-04); stale override keys were
 * already warned by map() (staleOverrideDiagnostic) so we do NOT re-warn here —
 * an unmatched key is simply inert via optional-chaining (never spreads the
 * overrides object, so a `__proto__`/`constructor` key is a harmless miss).
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
