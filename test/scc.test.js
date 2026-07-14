// GRAPH-04 (view half): canonicalCycles is the single Tarjan SCC helper shared by
// graph().cycles() AND map()'s CYCLE_SUSPECTED emission, so the two agree byte-for-byte.
// Canonical representation = lexically-sorted SCC membership (size >= 2), outer array
// sorted by first member — deterministic regardless of node/edge INPUT order (Pitfall 3).
// Plain ESM .js importing the built dist/internal/scc.mjs (D-06) — runs unmodified under
// `node --test` and `bun test` (D-05).

import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalCycles } from "../dist/internal/scc.mjs";

/** Build a from -> Set(to) adjacency Map from [from, to] edge pairs. */
function adj(edges) {
  const m = new Map();
  for (const [from, to] of edges) {
    if (!m.has(from)) m.set(from, new Set());
    if (!m.has(to)) m.set(to, new Set());
    m.get(from).add(to);
  }
  return m;
}

test("acyclic graph yields no cycles", () => {
  const nodes = ["a", "b", "c"];
  const g = adj([
    ["a", "b"],
    ["b", "c"],
  ]);
  assert.deepEqual(canonicalCycles(nodes, g), []);
});

test("2-cycle canonicalizes to a single lexically-sorted membership list", () => {
  const nodes = ["a", "b"];
  const g = adj([
    ["a", "b"],
    ["b", "a"],
  ]);
  assert.deepEqual(canonicalCycles(nodes, g), [["a", "b"]]);
});

test("3-cycle members are lexically sorted", () => {
  const nodes = ["a", "b", "c"];
  const g = adj([
    ["b", "c"],
    ["c", "a"],
    ["a", "b"],
  ]);
  assert.deepEqual(canonicalCycles(nodes, g), [["a", "b", "c"]]);
});

test("self-edges are not cycles (size >= 2 only)", () => {
  const nodes = ["a", "b"];
  const g = adj([
    ["a", "a"],
    ["a", "b"],
  ]);
  assert.deepEqual(canonicalCycles(nodes, g), []);
});

test("disjoint cycles: outer array sorted by first member", () => {
  const nodes = ["p", "q", "x", "y"];
  const g = adj([
    ["x", "y"],
    ["y", "x"],
    ["p", "q"],
    ["q", "p"],
  ]);
  assert.deepEqual(canonicalCycles(nodes, g), [
    ["p", "q"],
    ["x", "y"],
  ]);
});

test("deterministic under shuffled node + edge insertion order", () => {
  const edges = [
    ["a", "b"],
    ["b", "c"],
    ["c", "a"],
    ["d", "e"],
    ["e", "d"],
  ];
  const forward = canonicalCycles(["a", "b", "c", "d", "e"], adj(edges));
  const shuffledEdges = [
    ["e", "d"],
    ["c", "a"],
    ["b", "c"],
    ["d", "e"],
    ["a", "b"],
  ];
  const reversed = canonicalCycles(["e", "d", "c", "b", "a"], adj(shuffledEdges));
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
  assert.deepEqual(forward, [
    ["a", "b", "c"],
    ["d", "e"],
  ]);
});
