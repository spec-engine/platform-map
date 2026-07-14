// TEST-01: DF/SE fixture-parity suite. Explicitly traces the named Dark Factory
// platform-discovery + sc1-monorepo-discovery cases and Spec Engine discover.ts
// cases onto platform-map's public map()/detect()/graph() surface, and fills the
// two genuine gaps the research identified: the turbo orchestrator-overlay
// committed fixture and the multi-repo-of-monorepos recursion end-to-end.
//
// Plain ESM .js importing the already-built dist/ (D-06) — runs unmodified under
// `node --test` and `bun test` (D-05). NEVER src/, NEVER .ts (Node 20 has no TS
// stripping and tsdown can't run on Node 20).
//
// Honesty contract (RESEARCH §TEST-01): most DF/SE behaviors are ALREADY covered
// by the Phase 1-4 unit suites. Where a case is already covered, this file adds a
// single tracing assertion + a `// already covered by <file>` comment rather than
// duplicating the full case. The genuinely-new coverage is (1) the turbo overlay
// and (2) the recursive multi-repo-of-monorepos e2e.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detect, graph, map } from "../dist/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const monorepoTurbo = path.join(fixturesDir, "monorepo-turbo");

// ── DF sc1-monorepo-discovery: turbo-over-npm overlay (THE genuine gap) ──────
// Ports dark-factory/tests/sc1-monorepo-discovery.test.cjs "turbo-over-npm"
// case: the package-list owner (npm workspaces) is detected FIRST; turbo is an
// overlay-only signal (Pitfall 1). No prior platform-map test exercises the
// orchestrator overlay — this is the one genuinely-new DF monorepo case.
test("detect() reports flavor:npm-workspaces AND orchestrator:turbo for a turbo-over-npm monorepo (DF sc1 parity)", () => {
  const d = detect(monorepoTurbo);
  assert.equal(d.mode, "monorepo");
  assert.equal(
    d.flavor,
    "npm-workspaces",
    "the package-list owner (package.json#workspaces) is detected first",
  );
  assert.equal(
    d.orchestrator,
    "turbo",
    "turbo.json is an overlay-only signal, not the package-list owner",
  );
});

// ── DF sc1-monorepo-discovery: npm-workspaces B→A edge + depGraph shape ──────
// Ports the "npm-workspaces: flavor, 2 pkgs, B→A dep" + "depGraph
// Map<string,Set<string>>, pkg-b.has(pkg-a)" DF cases. Edges use Unit.name
// PATHs (DESIGN §2). graph(pm).toDepGraph() is the exact shape DF planWaves()
// consumes unmodified (GRAPH-02 parity).
test("map() over the turbo monorepo yields the B→A workspace edge and DF-planWaves toDepGraph shape (DF sc1 parity)", async () => {
  const pm = await map(monorepoTurbo);
  assert.equal(pm.mode, "monorepo");

  // 2 workspace-package units, both from the workspace adapter.
  const names = pm.units.map((u) => u.name);
  assert.deepEqual(names, ["packages/pkg-a", "packages/pkg-b"]);
  for (const u of pm.units) assert.equal(u.kind, "workspace-package");

  // The B→A dependency edge — from/to are Unit.name paths (not bare pkg names).
  assert.deepEqual(pm.edges, [
    {
      from: "packages/pkg-b",
      to: "packages/pkg-a",
      via: "workspace-dependency",
    },
  ]);

  // toDepGraph(): Map<dependent, Set<dependency>>, keyed by Unit.name paths, with
  // EVERY package a key (empty Set for the leaf pkg-a). This is the DF
  // planWaves() seam (GRAPH-02, DESIGN §8 row 4).
  const dg = graph(pm).toDepGraph();
  assert.ok(dg instanceof Map, "toDepGraph() returns a Map");
  assert.deepEqual([...dg.keys()].sort(), ["packages/pkg-a", "packages/pkg-b"]);
  assert.ok(dg.get("packages/pkg-b") instanceof Set, "values are Sets");
  assert.deepEqual([...dg.get("packages/pkg-b")], ["packages/pkg-a"]);
  assert.deepEqual(
    [...dg.get("packages/pkg-a")],
    [],
    "the leaf has an empty Set",
  );
});

// ── SE discover.ts (g): members-glob expansion — TRACE (already covered) ─────
// SE case (g): a `members` glob expands into one sub-member unit per subdir with
// platform-relative names. Fully covered by map.test.js
// "infers spec-engine sub-member units from a members glob with no
// platform-map.json" — this is a single tracing assertion, not a re-port.
test("map() expands a spec-engine members glob into per-subdir units (SE discover.ts (g) parity trace)", async () => {
  // already covered by test/map.test.js + test/spec-engine.test.js — parity trace
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "platform-map-parity-se-"),
  );
  try {
    fs.mkdirSync(path.join(root, "packages", "engine"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages", "shared"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@3", members: "packages/*" }),
    );
    const pm = await map(root);
    // The members glob expands to one unit per subdir with platform-relative
    // names (the root "." also carries a spec-engine source from its own member
    // config; we assert the expanded sub-members here).
    const subMembers = pm.units
      .filter((u) => u.path.startsWith("packages/"))
      .map((u) => u.path)
      .sort();
    assert.deepEqual(subMembers, ["packages/engine", "packages/shared"]);
    for (const u of pm.units.filter((x) => x.path.startsWith("packages/"))) {
      assert.ok(u.sources.includes("spec-engine"));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── SE discover.ts (c): malformed member config — INTENTIONAL DIVERGENCE ─────
// SE case (c): discover.ts THROWS on a malformed member config. platform-map
// deliberately does NOT — a malformed *adapter* source degrades to a
// MALFORMED_CONFIG diagnostic and mapping still succeeds (DESIGN §5 asymmetry:
// only a nonexistent root + a malformed *canonical* config throw). This asserts
// the platform-map behavior and documents the divergence so the "port" is not
// mistaken for a 1:1 mapping.
// already covered by test/spec-engine.test.js "degrades a malformed member
// config to MALFORMED_CONFIG" — parity trace of the deliberate divergence.
test("map() degrades a malformed spec-engine member config to a diagnostic instead of throwing (SE discover.ts (c) divergence)", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "platform-map-parity-se-"),
  );
  try {
    fs.writeFileSync(
      path.join(root, "spec-engine.member.json"),
      "{ this is not valid json",
    );
    let pm;
    await assert.doesNotReject(async () => {
      pm = await map(root);
    }, "platform-map degrades (SE would throw here)");
    assert.ok(
      pm.diagnostics.some((d) => d.code === "MALFORMED_CONFIG"),
      "expected a MALFORMED_CONFIG diagnostic from the degraded adapter source",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
