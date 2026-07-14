// CLI-01/02/05/06 (white-box): the pure cli-render helpers over the BUILT
// dist/internal/cli-render.mjs — parseArgs grammar, deterministic renderTree
// string, and the exitFor exit-2 gate. Plain ESM .js importing the already-built
// dist/ (D-06); runs unmodified under `node --test` and `bun test` (D-05).
//
// exit-2 is exercised HERE, white-box, on a synthetic PlatformMap carrying a
// hand-built severity:"error" diagnostic — no real directory tree produces one
// today (every library emitter is "warning"/"info"), so the gate is proven at
// the exitFor() level, never via a spawn fixture (see 04-01-PLAN reachability_note).

import assert from "node:assert/strict";
import { test } from "node:test";
import { serialize, toJSON } from "../dist/index.mjs";
import {
  exitFor,
  graphProjection,
  parseArgs,
  renderTree,
  toDot,
} from "../dist/internal/cli-render.mjs";

// ── A synthetic PlatformMap literal (>=1 nested units[]) ────────────────────
// First top-level unit is NOT last AND has a child, so the rendered child line
// carries the `│` vertical continuation prefix.
function buildMap(units) {
  return {
    name: "myplat",
    root: ".",
    mode: "multi-repo",
    schemaVersion: 1,
    edges: [],
    diagnostics: [],
    units,
  };
}

function leaf(name, mode, role) {
  return {
    name,
    path: name,
    kind: "workspace-package",
    mode,
    ref: null,
    units: [],
    signals: {},
    role,
    sources: [],
  };
}

function monoWithChild(name, childName) {
  return {
    name,
    path: name,
    kind: "repo",
    mode: "monorepo",
    ref: "main",
    units: [leaf(childName, "single-repo", "app")],
    signals: {},
    role: "library",
    sources: [],
  };
}

// ── parseArgs grammar table (CLI-06) ────────────────────────────────────────

test("parseArgs([]) → command map, dir '.', all flags false", () => {
  const a = parseArgs([]);
  assert.equal(a.command, "map");
  assert.equal(a.dir, ".");
  assert.equal(a.json, false);
  assert.equal(a.help, false);
  assert.equal(a.version, false);
  assert.equal(a.error, undefined);
});

test("parseArgs(['--json','./x']) → json true, dir './x'", () => {
  const a = parseArgs(["--json", "./x"]);
  assert.equal(a.json, true);
  assert.equal(a.dir, "./x");
  assert.equal(a.error, undefined);
});

test("parseArgs(['--nope']) → error set (unknown flag)", () => {
  const a = parseArgs(["--nope"]);
  assert.ok(a.error, "expected a truthy error for an unknown flag");
});

test("parseArgs(['-h']) → help true", () => {
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("parseArgs(['--version']) and ['-V'] → version true", () => {
  assert.equal(parseArgs(["--version"]).version, true);
  assert.equal(parseArgs(["-V"]).version, true);
});

test("parseArgs does not crash on later-slice tokens (detect/graph/init/--dot/--yes)", () => {
  assert.doesNotThrow(() => parseArgs(["detect"]));
  assert.doesNotThrow(() => parseArgs(["graph", "--dot"]));
  assert.doesNotThrow(() => parseArgs(["init", "--yes"]));
});

// ── renderTree (CLI-01): shape, box-drawing, determinism, no absolute path ──

test("renderTree emits header + box-drawing tree with nested continuation", () => {
  const out = renderTree(
    buildMap([
      monoWithChild("a-mono", "a-mono/pkg"),
      leaf("z-leaf", "single-repo", "app"),
    ]),
  );
  const lines = out.split("\n");
  assert.equal(lines[0], "myplat (multi-repo)", "header line = name (mode)");
  assert.ok(out.includes("├─ a-mono [monorepo, library]"), "branch line");
  assert.ok(out.includes("└─ z-leaf [single-repo, app]"), "last line");
  assert.ok(
    out.includes("│  └─ a-mono/pkg [single-repo, app]"),
    "nested child under │ continuation",
  );
  assert.equal(out.includes(String.fromCharCode(27)), false, "no ANSI escapes");
  assert.doesNotMatch(out, /\n$/, "no trailing newline");
});

test("renderTree prints no absolute path (process.cwd())", () => {
  const out = renderTree(buildMap([leaf("only", "single-repo", "app")]));
  assert.equal(out.includes(process.cwd()), false);
});

test("renderTree is deterministic regardless of input units[] order", () => {
  const ordered = renderTree(
    buildMap([
      monoWithChild("a-mono", "a-mono/pkg"),
      leaf("z-leaf", "single-repo", "app"),
    ]),
  );
  const shuffled = renderTree(
    buildMap([
      leaf("z-leaf", "single-repo", "app"),
      monoWithChild("a-mono", "a-mono/pkg"),
    ]),
  );
  assert.equal(shuffled, ordered);
});

// ── exitFor (CLI-05): the exit-2 gate on a synthetic error-severity map ─────

test("exitFor → 2 when any diagnostic is severity 'error'", () => {
  const pm = buildMap([]);
  pm.diagnostics = [
    { code: "CONFIG_CONFLICT", severity: "error", message: "synthetic error" },
  ];
  assert.equal(exitFor(pm), 2);
});

test("exitFor → 0 for only warning/info diagnostics", () => {
  const pm = buildMap([]);
  pm.diagnostics = [
    { code: "CONFIG_CONFLICT", severity: "warning", message: "w" },
    { code: "UNCONFIGURED_SIBLING", severity: "info", message: "i" },
  ];
  assert.equal(exitFor(pm), 0);
});

test("exitFor → 0 for an empty-diagnostics map", () => {
  assert.equal(exitFor(buildMap([])), 0);
});

// ── sanity: toJSON stays the --json seam (never JSON.stringify(pm)) ─────────

test("toJSON of a synthetic map parses with schemaVersion 1", () => {
  const parsed = JSON.parse(
    toJSON(buildMap([leaf("u", "single-repo", "app")])),
  );
  assert.equal(parsed.schemaVersion, 1);
});

// ── toDot (CLI-03): Graphviz digraph from the serialize()-sorted edge set ────
// A synthetic multi-repo map whose units are workspace-packages a/b/c with two
// edges given OUT of (from,to) order, so the DOT proves it renders in the
// serialize() order (a->c before b->a), not the input order.

function wp(name) {
  return {
    name,
    path: name,
    kind: "workspace-package",
    mode: "single-repo",
    ref: null,
    units: [],
    signals: {},
    role: "library",
    sources: [],
  };
}

function buildEdgeMap(units, edges) {
  return {
    name: "myplat",
    root: ".",
    mode: "multi-repo",
    schemaVersion: 1,
    edges,
    diagnostics: [],
    units,
  };
}

const EDGE_UNITS = [wp("a"), wp("b"), wp("c")];
const EDGES = [
  { from: "b", to: "a", via: "workspace-dependency" },
  { from: "a", to: "c", via: "workspace-dependency" },
];

test("toDot emits digraph header/footer + one arrow per edge in serialize order", () => {
  const out = toDot(buildEdgeMap(EDGE_UNITS, EDGES));
  const lines = out.split("\n");
  assert.equal(
    lines[0],
    "digraph platform {",
    "first line is the digraph header",
  );
  assert.equal(lines[lines.length - 1], "}", "last line closes the digraph");
  // serialize() sorts edges by (from,to): a->c precedes b->a regardless of input.
  assert.equal(lines[1], '  "a" -> "c";');
  assert.equal(lines[2], '  "b" -> "a";');
  assert.doesNotMatch(out, /\n$/, "no trailing newline");
});

test("toDot on a zero-edge map yields an empty-bodied digraph", () => {
  const out = toDot(buildEdgeMap([wp("solo")], []));
  assert.equal(out, "digraph platform {\n}");
});

// ── graphProjection (CLI-03, Open Q1): fully-serializable {nodes,edges,roots,leaves,cycles}

test("graphProjection returns the {nodes,edges,roots,leaves,cycles} shape reusing graph()", () => {
  const pm = buildEdgeMap(EDGE_UNITS, EDGES);
  const proj = graphProjection(pm);
  assert.deepEqual(Object.keys(proj).sort(), [
    "cycles",
    "edges",
    "leaves",
    "nodes",
    "roots",
  ]);
  // nodes: sorted list of ALL unit names.
  assert.deepEqual(proj.nodes, ["a", "b", "c"]);
  // edges === serialize(pm).edges (sorted, reused — not re-derived by the CLI).
  assert.deepEqual(proj.edges, serialize(pm).edges);
  assert.ok(proj.edges.length >= 1, "non-empty edge set");
  // roots = in-degree 0 (b), leaves = out-degree 0 (c), no cycles.
  assert.deepEqual(proj.roots, ["b"]);
  assert.deepEqual(proj.leaves, ["c"]);
  assert.deepEqual(proj.cycles, []);
});

test("graphProjection is JSON-serializable (no raw Map/Set leaked)", () => {
  const proj = graphProjection(buildEdgeMap(EDGE_UNITS, EDGES));
  assert.doesNotThrow(() => JSON.stringify(proj));
});

test("graphProjection is byte-stable across shuffled input of the same logical map", () => {
  const ordered = JSON.stringify(
    graphProjection(buildEdgeMap(EDGE_UNITS, EDGES)),
  );
  const shuffled = JSON.stringify(
    graphProjection(
      buildEdgeMap(
        [wp("c"), wp("a"), wp("b")],
        [
          { from: "a", to: "c", via: "workspace-dependency" },
          { from: "b", to: "a", via: "workspace-dependency" },
        ],
      ),
    ),
  );
  assert.equal(shuffled, ordered);
});
