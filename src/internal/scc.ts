// GRAPH-04: the single Tarjan strongly-connected-components helper. It is the ONE
// source of truth for cycle detection — consumed by BOTH graph().cycles() (Phase 3
// plan 02) AND map()'s CYCLE_SUSPECTED diagnostic emission (plan 03) — so the two
// agree byte-for-byte. Cycles NEVER throw (unlike DF's planWaves): this is a pure,
// terminating computation over a finite in-memory adjacency Map.
//
// Determinism (DETR-01/02, Pitfall 3): the canonical representation of a cycle is its
// LEXICALLY SORTED member list — NOT DFS traversal order, which is input-order
// dependent. The outer array is sorted by first member. Nodes are visited in sorted
// order so component discovery is input-order-independent even before the final
// canonical sort (belt-and-suspenders). Comparison is plain `<`/`>` — never a
// locale-aware method (ICU order is not stable across Node/ICU versions).
//
// No I/O: no fs, no child_process, no fetch. Pure structure in, sorted arrays out.

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
 * Returns strongly-connected components of size >= 2, each as a lexically-sorted
 * member list; the outer array is sorted by first member. Deterministic regardless
 * of node/edge input order (canonicalization by sort, not by traversal order).
 * Self-edges (to === from) never form a reported cycle: an SCC of a single node is
 * dropped by the size >= 2 filter.
 *
 * @param nodes     the full node set (order irrelevant — sorted internally).
 * @param adjacency from -> Set(to) forward-edge map.
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
        const lp = low.get(parent.v);
        const lvv = low.get(v);
        if (lp !== undefined && lvv !== undefined && lvv < lp) {
          low.set(parent.v, lvv);
        }
      }
    }
  }

  for (const c of sccs) c.sort(compare);
  sccs.sort((a, b) => compare(a[0], b[0]));
  return sccs;
}
