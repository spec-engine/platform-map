// GRAPH-01: workspace dependency edges. Proves the load-bearing packageName ->
// Unit.name (path) translation seam: package.json deps reference package NAMES,
// Unit.name is the platform-relative PATH, so buildEdges must translate via a
// per-sibling-set index. Also proves 4-field dep intersection, external-dep
// filtering, no-self-edge, per-sibling-set scoping (no cross-monorepo edges),
// populateDegrees (0 included), and toJSON shuffle-determinism.
//
// Plain ESM .js importing the built dist/ artifacts (D-06) — runs unmodified
// under `node --test` AND `bun test` (D-05). Determinism assertions route
// through toJSON (serialize.ts is the SOLE sort site; edges.ts never sorts).

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildEdges, populateDegrees } from "../dist/edges.mjs";
import { map } from "../dist/index.mjs";
import { toJSON } from "../dist/internal/serialize.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoEdges = path.join(here, "fixtures", "monorepo-edges");

/** Minimal workspace-package Unit literal for pure buildEdges/degree tests. */
function pkg(name, packageName, children = []) {
  return {
    name,
    path: name,
    kind: "workspace-package",
    mode: "single-repo",
    ref: null,
    units: children,
    signals: packageName === undefined ? {} : { packageName },
    role: "unknown",
    sources: ["pnpm-workspace.yaml"],
  };
}

function repo(name, children) {
  return {
    name,
    path: name,
    kind: "repo",
    mode: "monorepo",
    ref: "main",
    units: children,
    signals: {},
    role: "unknown",
    sources: ["siblings"],
  };
}

// ── Pure buildEdges: name->path translation, external filter, no self-edge ──

test("buildEdges translates dep NAMES to target Unit.name PATHs; externals filtered; no self-edge", () => {
  const units = [pkg("packages/lib", "@scope/lib"), pkg("apps/web", "web")];
  // web depends on @scope/lib (internal), react (external), and its OWN name.
  const depsOf = (u) =>
    u.name === "apps/web" ? ["@scope/lib", "react", "web"] : [];

  const { edges, diagnostics } = buildEdges(units, depsOf);

  assert.deepEqual(edges, [
    { from: "apps/web", to: "packages/lib", via: "workspace-dependency" },
  ]);
  assert.deepEqual(diagnostics, []);
});

// ── Per-sibling-set scoping: no phantom cross-monorepo edge ──────────────────

test("buildEdges scopes the index per sibling set — a shared package name across two monorepos yields NO cross-set edge", () => {
  const units = [
    repo("repoA", [
      pkg("repoA/shared", "@x/shared"),
      pkg("repoA/app", "@x/app-a"),
    ]),
    repo("repoB", [pkg("repoB/shared", "@x/shared")]),
  ];
  // repoA/app depends on @x/shared — must resolve to repoA/shared, never repoB/shared.
  const depsOf = (u) => (u.name === "repoA/app" ? ["@x/shared"] : []);

  const { edges } = buildEdges(units, depsOf);

  assert.deepEqual(edges, [
    { from: "repoA/app", to: "repoA/shared", via: "workspace-dependency" },
  ]);
  // No edge whose from/to straddle repoA and repoB.
  assert.ok(
    !edges.some((e) => e.to === "repoB/shared"),
    "expected no cross-set edge to repoB/shared",
  );
});

// ── Duplicate packageName within one sibling set ────────────────────────────

test("a duplicate packageName within a sibling set emits CONFIG_CONFLICT; first claimant keeps the slot", () => {
  const units = [
    pkg("packages/lib-a", "@x/lib"),
    pkg("packages/lib-b", "@x/lib"),
    pkg("apps/web", "@x/web"),
  ];
  const depsOf = (u) => (u.name === "apps/web" ? ["@x/lib"] : []);

  const { edges, diagnostics } = buildEdges(units, depsOf);

  assert.deepEqual(edges, [
    { from: "apps/web", to: "packages/lib-a", via: "workspace-dependency" },
  ]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "CONFIG_CONFLICT");
  assert.equal(diagnostics[0].path, "packages/lib-b");
  assert.match(diagnostics[0].message, /"@x\/lib"/);
});

// ── Losing claimant self-reference: no phantom edge to the winner (EDGE-03) ──

test("a losing duplicate-packageName claimant depending on its OWN name yields NO edge to the winner", () => {
  const units = [
    pkg("packages/lib-a", "@x/lib"),
    pkg("packages/lib-b", "@x/lib"),
  ];
  // lib-b lost the "@x/lib" slot and self-references its own package name.
  const depsOf = (u) => (u.name === "packages/lib-b" ? ["@x/lib"] : []);

  const { edges, diagnostics } = buildEdges(units, depsOf);

  assert.deepEqual(edges, []);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "CONFIG_CONFLICT");
  assert.equal(diagnostics[0].path, "packages/lib-b");
});

test("losing the slot does not mute the unit's other deps: the loser's edge to a third package survives", () => {
  const units = [
    pkg("packages/lib-a", "@x/lib"),
    pkg("packages/lib-b", "@x/lib"),
    pkg("packages/lib-c", "@x/c"),
  ];
  const depsOf = (u) => (u.name === "packages/lib-b" ? ["@x/lib", "@x/c"] : []);

  const { edges } = buildEdges(units, depsOf);

  assert.deepEqual(edges, [
    {
      from: "packages/lib-b",
      to: "packages/lib-c",
      via: "workspace-dependency",
    },
  ]);
});

test("the winning claimant depending on its own package name still yields no edge", () => {
  const units = [
    pkg("packages/lib-a", "@x/lib"),
    pkg("packages/lib-b", "@x/lib"),
  ];
  const depsOf = (u) => (u.name === "packages/lib-a" ? ["@x/lib"] : []);

  const { edges } = buildEdges(units, depsOf);

  assert.deepEqual(edges, []);
});

// ── populateDegrees: 3-node chain, explicit 0 written ───────────────────────

test("populateDegrees writes workspaceInDegree/workspaceOutDegree (0 included) over a 3-node chain", () => {
  const a = pkg("a", "@c/a");
  const b = pkg("b", "@c/b");
  const c = pkg("c", "@c/c");
  const edges = [
    { from: "a", to: "b", via: "workspace-dependency" },
    { from: "b", to: "c", via: "workspace-dependency" },
  ];

  populateDegrees([a, b, c], edges);

  assert.equal(a.signals.workspaceInDegree, 0);
  assert.equal(a.signals.workspaceOutDegree, 1);
  assert.equal(b.signals.workspaceInDegree, 1);
  assert.equal(b.signals.workspaceOutDegree, 1);
  assert.equal(c.signals.workspaceInDegree, 1);
  assert.equal(c.signals.workspaceOutDegree, 0);
});

// ── e2e via map(): real edges over the monorepo-edges fixture ────────────────

test("map() populates pm.edges with workspace edges (from/to as PATHs, external dep filtered)", async () => {
  const pm = await map(monorepoEdges);

  // apps/web -> packages/lib (dependencies) and apps/web -> packages/util (devDependencies).
  assert.ok(
    pm.edges.some((e) => e.from === "apps/web" && e.to === "packages/lib"),
    `expected apps/web -> packages/lib, got ${JSON.stringify(pm.edges)}`,
  );
  assert.ok(
    pm.edges.some((e) => e.from === "apps/web" && e.to === "packages/util"),
    `expected apps/web -> packages/util, got ${JSON.stringify(pm.edges)}`,
  );
  // from/to are PATHs, never package NAMES.
  for (const e of pm.edges) {
    assert.ok(
      !e.from.startsWith("@") && !e.to.startsWith("@"),
      `edge endpoints must be paths, not names: ${JSON.stringify(e)}`,
    );
  }
  // The external `react` dep must never appear as an edge endpoint.
  assert.ok(
    !pm.edges.some((e) => e.to === "react" || e.from === "react"),
    "external dep react must be filtered out",
  );
  // Every edge is the one v1 kind.
  for (const e of pm.edges) {
    assert.equal(e.via, "workspace-dependency");
  }
});

// ── Determinism (DETR-02): toJSON byte-identical under shuffled units/edges ──

test("toJSON is byte-identical regardless of unit/edge input ordering", () => {
  const lib = pkg("packages/lib", "@scope/lib");
  const util = pkg("packages/util", "@scope/util");
  const web = pkg("apps/web", "web");
  const edgeA = {
    from: "apps/web",
    to: "packages/lib",
    via: "workspace-dependency",
  };
  const edgeB = {
    from: "apps/web",
    to: "packages/util",
    via: "workspace-dependency",
  };

  const wrap = (units, edges) =>
    toJSON({
      name: "edges-fixture",
      root: ".",
      mode: "monorepo",
      units,
      edges,
      diagnostics: [],
      schemaVersion: 1,
    });

  const forward = wrap([lib, util, web], [edgeA, edgeB]);
  const shuffled = wrap([web, util, lib], [edgeB, edgeA]);

  assert.equal(forward, shuffled);
});
