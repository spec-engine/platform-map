// package.json deps reference package NAMES (signals.packageName) while
// Unit.name is a platform-relative PATH, so edges must be translated through a
// per-sibling-set Map<packageName, Unit.name> index; a global index would
// fabricate cross-monorepo edges. The index is a Map, never a plain object, so
// hostile dep keys like __proto__ are inert. Pure module: no I/O, no sorting.

import type { Diagnostic, Edge, Unit } from "./types.js";

export interface BuildEdgesResult {
  edges: Edge[];
  diagnostics: Diagnostic[];
}

/**
 * Builds the workspace-dependency edges for a unit tree. `depsOf` supplies a
 * unit's raw dep-name candidates (all four manifest dep fields). External deps
 * and self-edges are dropped; a duplicate packageName within one sibling set
 * emits CONFIG_CONFLICT and the first claimant keeps the index slot. Returns
 * natural order.
 */
export function buildEdges(
  units: Unit[],
  depsOf: (u: Unit) => string[],
): BuildEdgesResult {
  const edges: Edge[] = [];
  const diagnostics: Diagnostic[] = [];
  visitSet(units, depsOf, edges, diagnostics);
  return { edges, diagnostics };
}

/** One sibling set: scoped name index, its edges, then each nested monorepo's
 *  children as a fresh, independently scoped set. */
function visitSet(
  siblings: Unit[],
  depsOf: (u: Unit) => string[],
  out: Edge[],
  diagnostics: Diagnostic[],
): void {
  const idx = new Map<string, string>();
  for (const u of siblings) {
    if (u.kind !== "workspace-package") continue;
    const pkgName = u.signals.packageName;
    if (pkgName === undefined) continue;
    const claimed = idx.get(pkgName);
    if (claimed !== undefined) {
      diagnostics.push({
        code: "CONFIG_CONFLICT",
        severity: "warning",
        path: u.name,
        message:
          `CONFIG_CONFLICT: package name "${pkgName}" is claimed by both ` +
          `"${claimed}" and "${u.name}"; edges resolve to "${claimed}"`,
      });
      continue;
    }
    idx.set(pkgName, u.name);
  }
  for (const u of siblings) {
    if (u.kind === "workspace-package") {
      for (const depName of depsOf(u)) {
        const to = idx.get(depName);
        if (to === undefined || to === u.name) continue;
        out.push({ from: u.name, to, via: "workspace-dependency" });
      }
    }
    if (u.units.length > 0) visitSet(u.units, depsOf, out, diagnostics);
  }
}

/**
 * Writes `workspaceInDegree`/`workspaceOutDegree` onto every workspace-package
 * unit at all depths. 0 is written explicitly; deriveRole reads presence, so
 * absence would misclassify. Global counting over the flat edge list is safe
 * because Unit.name is unique and edges never leave a sibling set.
 */
export function populateDegrees(units: Unit[], edges: Edge[]): void {
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of edges) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  const walk = (list: Unit[]): void => {
    for (const u of list) {
      if (u.kind === "workspace-package") {
        u.signals.workspaceInDegree = inDeg.get(u.name) ?? 0;
        u.signals.workspaceOutDegree = outDeg.get(u.name) ?? 0;
      }
      if (u.units.length > 0) walk(u.units);
    }
  };
  walk(units);
}
