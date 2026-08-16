// The pure graph(pm) view over a PlatformMap: operates ONLY on pm.edges and
// pm.units, no I/O. toDepGraph() is the seam Dark Factory's planWaves() binds
// to: the exact Map<dependent, Set<dependency>> DF consumes unmodified. Every
// array result is lexically sorted with the plain `<`/`>` comparator (a
// view-layer ordering); cycles() delegates to canonicalCycles so it agrees
// byte-for-byte with map()'s CYCLE_SUSPECTED diagnostics.

import { canonicalCycles } from "./internal/scc.js";
import type { PlatformGraph, PlatformMap, Unit } from "./types.js";

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Builds the pure query view for a PlatformMap: recursively collects every
 * kind:"workspace-package" name, builds forward and reverse adjacency maps
 * seeded for every name, and exposes the six PlatformGraph methods. The
 * transitive closures use a `seen` guard so cyclic graphs terminate.
 */
export function graph(pm: PlatformMap): PlatformGraph {
  const names: string[] = [];
  const collect = (list: Unit[]): void => {
    for (const u of list) {
      if (u.kind === "workspace-package") names.push(u.name);
      if (u.units.length > 0) collect(u.units);
    }
  };
  collect(pm.units);
  names.sort(compare);

  const dep = new Map<string, Set<string>>(); // from -> Set(to)
  const rev = new Map<string, Set<string>>(); // to -> Set(from)
  for (const n of names) {
    dep.set(n, new Set());
    rev.set(n, new Set());
  }
  for (const e of pm.edges) {
    dep.get(e.from)?.add(e.to);
    rev.get(e.to)?.add(e.from);
  }

  // Transitive closure from `start` over adjacency `g`, excluding the start
  // node, returned lexically sorted; `seen` guarantees termination on cycles.
  const closure = (start: string, g: Map<string, Set<string>>): string[] => {
    const seen = new Set<string>();
    const stack: string[] = [start];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      for (const nx of g.get(cur) ?? []) {
        if (!seen.has(nx) && nx !== start) {
          seen.add(nx);
          stack.push(nx);
        }
      }
    }
    return [...seen].sort(compare);
  };

  return {
    toDepGraph: (): Map<string, Set<string>> => {
      // Seed EVERY workspace-package name (empty Set for leaves). Inner Sets
      // are built from lexically-sorted deps so iteration order stays
      // deterministic even for a caller-built PlatformMap that never passed
      // through serialize().
      const g = new Map<string, Set<string>>();
      for (const n of names)
        g.set(n, new Set([...(dep.get(n) ?? [])].sort(compare)));
      return g;
    },
    dependenciesOf: (name: string): string[] => closure(name, dep),
    dependentsOf: (name: string): string[] => closure(name, rev),
    roots: (): string[] =>
      names.filter((n) => (rev.get(n)?.size ?? 0) === 0).sort(compare), // in-degree 0
    leaves: (): string[] =>
      names.filter((n) => (dep.get(n)?.size ?? 0) === 0).sort(compare), // out-degree 0
    cycles: (): string[][] => canonicalCycles(names, dep),
  };
}
