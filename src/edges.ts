// buildEdges() / populateDegrees(): the pure workspace-dependency-edge builder
// and degree-counter (GRAPH-01). map()-facing, analog of merge.ts (a pure,
// I/O-free transform returning order-independent output).
//
// THE load-bearing seam: package.json deps reference package NAMES
// (`@scope/lib`, held in signals.packageName); Unit.name is the platform-relative
// PATH (`packages/lib`). buildEdges builds a PER-SIBLING-SET
// `Map<packageName, Unit.name>` index and translates each matched dep name into a
// target Unit.name path. Intersecting raw dep names against the path-keyed unit
// set silently yields ZERO edges (Pitfall 1). The index is scoped per sibling
// set (never global) so a package name that collides across two separate
// monorepos cannot produce a phantom cross-repo edge (Pitfall 2).
//
// This module deliberately does NOT:
//   - sort anything — serialize.ts is the SOLE sort site (it sorts edges by
//     (from,to)); buildEdges returns natural order and the shuffle test proves
//     that output is order-independent once serialized.
//   - perform any I/O (SEC-05): it consumes an injected `depsOf` callback backed
//     by the census side-table; no fs/child_process/fetch here.
//   - assign untrusted dep-name strings into a plain object — the index is a
//     `Map` (proto-safe), so a `__proto__`/`constructor` dep key is inert (T-03-02).
//
// The four dep fields feeding `depsOf` are the documented CONTEXT superset of
// DF's three (adds optionalDependencies), so edges may differ from DF's live
// buildDepGraph on optional deps — deliberately.

import type { Edge, Unit } from "./types.js";

/**
 * Builds the workspace-dependency edges for a unit tree. `depsOf` returns a
 * unit's raw workspace dep-NAME candidates (the union of its four manifest
 * dep-field keys), sourced from the map()-owned census side-table. Edges are the
 * intersection of those dep names with the sibling set's package-name index,
 * translated to target `Unit.name` paths; external deps (index miss) and
 * self-edges are dropped. Returns natural order — NEVER sorts.
 */
export function buildEdges(
  units: Unit[],
  depsOf: (u: Unit) => string[],
): Edge[] {
  const edges: Edge[] = [];
  visitSet(units, depsOf, edges);
  return edges;
}

/** Processes one sibling set: builds its scoped packageName -> Unit.name index,
 *  emits each workspace-package's internal edges, then recurses into nested
 *  monorepo children (each a fresh, independently-scoped sibling set). */
function visitSet(
  siblings: Unit[],
  depsOf: (u: Unit) => string[],
  out: Edge[],
): void {
  const idx = new Map<string, string>();
  for (const u of siblings) {
    if (u.kind !== "workspace-package") continue;
    const pkgName = u.signals.packageName;
    if (pkgName !== undefined) idx.set(pkgName, u.name);
  }
  for (const u of siblings) {
    if (u.kind === "workspace-package") {
      for (const depName of depsOf(u)) {
        const to = idx.get(depName);
        // external dep (index miss) filtered; self-edge dropped.
        if (to === undefined || to === u.name) continue;
        out.push({ from: u.name, to, via: "workspace-dependency" });
      }
    }
    if (u.units.length > 0) visitSet(u.units, depsOf, out);
  }
}

/**
 * Writes `workspaceInDegree`/`workspaceOutDegree` onto every
 * kind:"workspace-package" unit at all depths from the flat `edges` array. 0 is
 * set EXPLICITLY (presence is meaningful for deriveRole — MODEL-02/GRAPH-05).
 * Because edges only ever form within a sibling set and Unit.name is globally
 * unique (MODEL-05), global counting over the flat array equals per-set counting.
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
