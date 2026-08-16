// [GRAPH-04] The single Tarjan SCC helper, the one source of truth for cycle
// detection, so graph().cycles() and map()'s CYCLE_SUSPECTED diagnostics agree
// byte-for-byte. The canonical representation of a cycle is its LEXICALLY
// SORTED member list, NOT DFS traversal order, which is input-order dependent;
// the outer array is sorted by first member, and nodes are visited in sorted
// order as well. Comparison is plain `<`/`>`, never a locale-aware method.
// Pure structure in, sorted arrays out; no I/O.

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

interface Frame {
  v: string;
  i: number;
  neighbors: string[];
}

/**
 * Returns strongly-connected components of size >= 2, each as a lexically
 * sorted member list; the outer array is sorted by first member. Deterministic
 * regardless of node/edge input order. A self-edge alone never forms a
 * reported cycle: single-node SCCs are dropped by the size filter.
 * `adjacency` is a from -> Set(to) forward-edge map.
 */
export function canonicalCycles(
  nodes: string[],
  adjacency: Map<string, Set<string>>,
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let idx = 0;

  const sorted = [...nodes].sort(compare);

  for (const start of sorted) {
    if (index.has(start)) continue;
    const work: Frame[] = [{ v: start, i: 0, neighbors: [] }];

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break; // unreachable: while-guard ensures work is non-empty
      const v = frame.v;

      // First visit to this frame's node: assign index/lowlink and push on the SCC stack.
      if (!index.has(v)) {
        index.set(v, idx);
        low.set(v, idx);
        idx++;
        stack.push(v);
        onStack.add(v);
        frame.neighbors = [...(adjacency.get(v) ?? [])].sort(compare);
      }

      let recursed = false;
      while (frame.i < frame.neighbors.length) {
        const w = frame.neighbors[frame.i];
        frame.i++;
        if (w === undefined) continue; // unreachable: i < neighbors.length
        if (!index.has(w)) {
          work.push({ v: w, i: 0, neighbors: [] });
          recursed = true;
          break;
        }
        if (onStack.has(w)) {
          const lv = low.get(v);
          const iw = index.get(w);
          if (lv !== undefined && iw !== undefined && iw < lv) low.set(v, iw);
        }
      }
      if (recursed) continue;

      // All neighbors processed: if v is an SCC root, pop its component off the stack.
      if (low.get(v) === index.get(v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop() as string;
          onStack.delete(w);
          comp.push(w);
        } while (w !== v);
        if (comp.length >= 2) sccs.push(comp);
      }

      work.pop();
      // Propagate v's lowlink up to its parent (the return-from-recursion update).
      if (work.length > 0) {
        const parent = work[work.length - 1];
        if (parent !== undefined) {
          const lp = low.get(parent.v);
          const lvv = low.get(v);
          if (lp !== undefined && lvv !== undefined && lvv < lp) {
            low.set(parent.v, lvv);
          }
        }
      }
    }
  }

  for (const c of sccs) c.sort(compare);
  // Each SCC has length >= 2 (size filter above), so a[0]/b[0] are always defined;
  // the `?? ""` fallback satisfies noUncheckedIndexedAccess without changing order.
  sccs.sort((a, b) => compare(a[0] ?? "", b[0] ?? ""));
  return sccs;
}
