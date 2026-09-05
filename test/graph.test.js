// (view side): graph(pm) is the pure view over pm.edges + pm.units that
// Dark Factory's planWaves binds to. toDepGraph() returns the EXACT Map<string,Set<string>>
// (dependent -> Set(dependency)) Dark Factory consumes unmodified; dependenciesOf/dependentsOf are
// transitive lex-sorted closures; roots()/leaves() are in/out-degree 0; cycles() delegates
// to the shared canonicalCycles. No I/O, sorts via plain `<`/`>` (never localeCompare).
// Plain ESM .js importing built dist/graph.mjs + dist/internal/serialize.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { graph } from "../dist/graph.mjs";

/** Vendored, UNMODIFIED copy of Dark Factory's planWaves
 *  (a dependency-ordering wave planner). The parity contract is:
 *  feeding graph(pm).toDepGraph() + the unit-name list into this body produces waves
 *  with no adaptation. Do NOT edit this to make the test pass — that would break the seam. */
function planWaves(packages, depGraph) {
  const inDegree = new Map(packages.map((p) => [p.name, 0]));
  const reverse = new Map(packages.map((p) => [p.name, new Set()]));

  for (const [dependent, deps] of depGraph) {
    if (!inDegree.has(dependent)) continue;
    for (const dep of deps) {
      if (!inDegree.has(dep)) continue;
      inDegree.set(dependent, inDegree.get(dependent) + 1);
      reverse.get(dep).add(dependent);
    }
  }

  const waves = [];
  const remaining = new Set(packages.map((p) => p.name));

  while (remaining.size > 0) {
    const wave = [...remaining].filter((n) => inDegree.get(n) === 0).sort();
    if (wave.length === 0) {
      const cyclic = [...remaining].sort().join(", ");
      throw new Error(`cycle in package dep-graph: ${cyclic}`);
    }
    waves.push(wave);
    for (const n of wave) {
      remaining.delete(n);
      for (const dependent of reverse.get(n)) {
        inDegree.set(dependent, inDegree.get(dependent) - 1);
      }
    }
  }
  return waves;
}

/** Minimal workspace-package Unit. */
function wp(name, units = []) {
  return {
    name,
    path: name,
    kind: "workspace-package",
    mode: "single-repo",
    ref: null,
    units,
    signals: {},
    role: "unknown",
    sources: ["pnpm-workspace.yaml"],
  };
}

function edge(from, to) {
  return { from, to, via: "workspace-dependency" };
}

/** PlatformMap literal from a flat unit list + edge pairs. */
function pmOf(units, edgePairs) {
  return {
    name: "acme",
    root: ".",
    mode: "monorepo",
    units,
    edges: edgePairs.map(([f, t]) => edge(f, t)),
    diagnostics: [],
    schemaVersion: 1,
  };
}

// Acyclic diamond: app -> {engine, ui}; engine -> core; ui -> core; core leaf.
function diamond() {
  return pmOf(
    [wp("app"), wp("core"), wp("engine"), wp("ui")],
    [
      ["app", "engine"],
      ["app", "ui"],
      ["engine", "core"],
      ["ui", "core"],
    ],
  );
}

test("toDepGraph: key=dependent (Edge.from) -> Set of dependency names (Edge.to)", () => {
  const g = graph(diamond()).toDepGraph();
  assert.ok(g instanceof Map);
  assert.ok(g.get("app") instanceof Set);
  assert.deepEqual([...g.get("app")].sort(), ["engine", "ui"]);
  assert.deepEqual([...g.get("engine")], ["core"]);
});

test("toDepGraph: EVERY workspace-package is a key, leaves get an empty Set", () => {
  const g = graph(diamond()).toDepGraph();
  assert.deepEqual([...g.keys()].sort(), ["app", "core", "engine", "ui"]);
  assert.equal(g.get("core").size, 0);
});

// inner Set iteration must be lexically sorted regardless of edge input
// order — deterministic even for a caller-built PlatformMap not run through
// serialize.ts (whose edges arrive here in reverse-lexical order).
test("toDepGraph: inner Set iteration is lexically sorted regardless of edge order", () => {
  const pm = pmOf(
    [wp("app"), wp("alpha"), wp("beta"), wp("gamma")],
    [
      ["app", "gamma"],
      ["app", "beta"],
      ["app", "alpha"],
    ],
  );
  assert.deepEqual(
    [...graph(pm).toDepGraph().get("app")],
    ["alpha", "beta", "gamma"],
  );
});

test("toDepGraph: recurses into nested monorepo, collects only workspace-packages", () => {
  // The monorepo container is kind:"repo" (not a workspace-package); only its
  // nested workspace-packages are graph nodes.
  const container = {
    name: "root",
    path: "root",
    kind: "repo",
    mode: "monorepo",
    ref: "main",
    units: [wp("root/a"), wp("root/b")],
    signals: {},
    role: "unknown",
    sources: ["pnpm-workspace.yaml"],
  };
  const pm = pmOf([container], [["root/a", "root/b"]]);
  const g = graph(pm).toDepGraph();
  assert.deepEqual([...g.keys()].sort(), ["root/a", "root/b"]);
  assert.deepEqual([...g.get("root/a")], ["root/b"]);
});

test("planWaves parity: Dark Factory's UNMODIFIED planWaves consumes toDepGraph() directly", () => {
  const pm = diamond();
  const gv = graph(pm);
  const packages = [...gv.toDepGraph().keys()].map((name) => ({ name }));
  const waves = planWaves(packages, gv.toDepGraph());
  // core has no deps -> wave 0; engine+ui depend on core -> wave 1; app last.
  assert.deepEqual(waves, [["core"], ["engine", "ui"], ["app"]]);
});

test("dependenciesOf / dependentsOf: transitive, lexically sorted", () => {
  const gv = graph(diamond());
  assert.deepEqual(gv.dependenciesOf("app"), ["core", "engine", "ui"]);
  assert.deepEqual(gv.dependenciesOf("engine"), ["core"]);
  assert.deepEqual(gv.dependenciesOf("core"), []);
  assert.deepEqual(gv.dependentsOf("core"), ["app", "engine", "ui"]);
  assert.deepEqual(gv.dependentsOf("app"), []);
});

test("closures terminate on a cyclic fixture (seen-guarded, no hang)", () => {
  const pm = pmOf(
    [wp("a"), wp("b"), wp("c")],
    [
      ["a", "b"],
      ["b", "a"],
      ["a", "c"],
    ],
  );
  const gv = graph(pm);
  assert.deepEqual(gv.dependenciesOf("a"), ["b", "c"]);
  assert.deepEqual(gv.dependentsOf("b"), ["a"]);
});

test("roots() = in-degree 0; leaves() = out-degree 0 (both sorted)", () => {
  const gv = graph(diamond());
  assert.deepEqual(gv.roots(), ["app"]);
  assert.deepEqual(gv.leaves(), ["core"]);
});

test("cycles(): 2-cycle -> [[a,b]], stable across repeated calls", () => {
  const pm = pmOf(
    [wp("a"), wp("b")],
    [
      ["a", "b"],
      ["b", "a"],
    ],
  );
  const gv = graph(pm);
  assert.deepEqual(gv.cycles(), [["a", "b"]]);
  assert.equal(JSON.stringify(gv.cycles()), JSON.stringify(gv.cycles()));
});

test("cycles(): acyclic fixture -> []", () => {
  assert.deepEqual(graph(diamond()).cycles(), []);
});
