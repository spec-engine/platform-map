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
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detect, graph, map } from "../dist/index.mjs";
import { toJSON } from "../dist/internal/serialize.mjs";

// NOTE (Pitfall 3): dist/internal/serialize.mjs is imported here only because the
// node:test lane runs against the full dist/. It is NOT shipped in the tarball —
// the cold-install smoke (05-02) exercises the public exports only.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const monorepoTurbo = path.join(fixturesDir, "monorepo-turbo");
const syntheticSpecEngine = path.join(fixturesDir, "synthetic-spec-engine");

function gitAvailable() {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
const GIT = gitAvailable();

// Recursively collect every unit.path in a PlatformMap. Units nest under
// kind:"repo" constituents in the multi-repo-of-monorepos tree; every path must
// stay platform-relative (the portability half of the determinism contract —
// only PlatformMap.root is the documented caller-given absolute anchor).
function collectUnitPaths(units, acc = []) {
  for (const u of units) {
    acc.push(u.path);
    if (u.units.length > 0) collectUnitPaths(u.units, acc);
  }
  return acc;
}

// Build a fresh multi-repo-of-monorepos tree under `parent`: two monorepo
// siblings (each a .git-marked repo whose own packages carry a B→A workspace
// dep + a start-scripted app), plus a plain non-repo workdir map() is pointed
// at. Returns the workdir. Mirrors the DESIGN §8 row-4 shape (RESEARCH 245-260).
function buildMultiRepoOfMonorepos(parent) {
  for (const [sib, lib, app] of [
    ["sibling-a", "core", "api"],
    ["sibling-b", "lib", "web"],
  ]) {
    const root = path.join(parent, sib);
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );
    const libDir = path.join(root, "packages", lib);
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(
      path.join(libDir, "package.json"),
      JSON.stringify({
        name: `@${sib}/${lib}`,
        private: true,
        exports: { ".": "./index.js" },
      }),
    );
    const appDir = path.join(root, "packages", app);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "package.json"),
      JSON.stringify({
        name: `@${sib}/${app}`,
        dependencies: { [`@${sib}/${lib}`]: "workspace:*" },
        scripts: { start: "node ." },
      }),
    );
  }
  const workdir = path.join(parent, "workdir");
  fs.mkdirSync(workdir);
  return workdir;
}

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

// ── The richest DF port: multi-repo-of-monorepos recursion end-to-end ────────
// DESIGN §8 row 4 + DET-02 composability, built entirely in os.tmpdir() (a
// committed .git can't exist — Pitfall 1). Two monorepo siblings, each promoted
// to a kind:"repo" unit that itself reports mode:"monorepo" with its
// workspace-package children expanded, per-sibling edges (no cross-repo edge),
// and roles derived per-monorepo. Guarded on git availability; with bare .git
// markers the ref probe yields ref:null on both branches (real-repo refs are
// covered by map.test.js:258-313), so this asserts the ref:null fallback rather
// than skipping silently when git is absent.
test("map() maps a multi-repo-of-monorepos tree recursively (DET-02 composability e2e)", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-mrom-"));
  try {
    const workdir = buildMultiRepoOfMonorepos(parent);
    const pm = await map(workdir);

    // Top node: multi-repo of two promoted repo constituents.
    assert.equal(pm.mode, "multi-repo");
    const siblings = pm.units.filter((u) => u.kind === "repo");
    assert.deepEqual(siblings.map((u) => u.name).sort(), [
      "sibling-a",
      "sibling-b",
    ]);

    for (const sib of siblings) {
      // Each constituent is itself a monorepo, discovered via siblings.
      assert.equal(sib.kind, "repo");
      assert.equal(
        sib.mode,
        "monorepo",
        "a repo constituent that is itself a monorepo reports mode:monorepo",
      );
      assert.ok(sib.sources.includes("siblings"));
      // Bare .git marker -> ref:null (both when git is present and when absent).
      assert.equal(
        sib.ref,
        null,
        GIT ? "bare .git marker resolves no ref" : "git absent -> ref:null",
      );
    }

    // sibling-a's nested workspace-package units are sorted and workspace-only.
    const sibA = siblings.find((u) => u.name === "sibling-a");
    assert.deepEqual(
      sibA.units.map((u) => u.name),
      ["sibling-a/packages/api", "sibling-a/packages/core"],
    );
    for (const child of sibA.units) {
      assert.equal(child.kind, "workspace-package");
      assert.deepEqual(child.sources, ["workspace"]);
    }

    // Roles derive PER-MONOREPO: the depended-on lib is a library (inDegree>0);
    // the start-scripted app is an app (deriveRole rule 1).
    const roleByName = {};
    for (const sib of siblings)
      for (const child of sib.units) roleByName[child.name] = child.role;
    assert.equal(roleByName["sibling-a/packages/core"], "library");
    assert.equal(roleByName["sibling-a/packages/api"], "app");

    // Edges are scoped PER SIBLING SET: @sibA/api→@sibA/core and
    // @sibB/web→@sibB/lib; NO cross-repo edge. from/to are Unit.name paths.
    assert.deepEqual(pm.edges, [
      {
        from: "sibling-a/packages/api",
        to: "sibling-a/packages/core",
        via: "workspace-dependency",
      },
      {
        from: "sibling-b/packages/web",
        to: "sibling-b/packages/lib",
        via: "workspace-dependency",
      },
    ]);

    // Portability: every unit.path is platform-relative — no absolute path
    // (and no temp `parent`) leaks into a unit path. (PlatformMap.root is the
    // documented caller-given anchor and is excluded by design.)
    for (const p of collectUnitPaths(pm.units)) {
      assert.equal(
        path.isAbsolute(p),
        false,
        `unit path ${p} must be relative`,
      );
      assert.equal(p.includes(parent), false);
    }

    // DETR-02: byte-identical across two invocations of the same temp tree.
    assert.equal(toJSON(await map(workdir)), toJSON(await map(workdir)));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// ── SE discover.ts (a)/(d): sibling classification + lex order ───────────────
// SE case (a): a sibling repo-root with .git + package.json but no member/adapter
// config is a `skipped` entry — in platform-map, when a canonical config declares
// units[] the promotion gate suppresses such siblings and emits an
// UNCONFIGURED_SIBLING diagnostic (bucket-2 parity, DESIGN §8 SE row 1). SE case
// (d): two repo-root siblings are reported in lexical-by-name order — DETR-01, the
// serializer is the sole sort site.
test("map() emits UNCONFIGURED_SIBLING for unconfigured siblings in lexical order (SE discover.ts (a)/(d) parity)", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-se-sib-"));
  try {
    // Two repo-root siblings (deliberately out of lexical order on disk) with
    // .git + package.json but no adapter/member config.
    for (const name of ["zulu-repo", "alpha-repo"]) {
      const r = path.join(parent, name);
      fs.mkdirSync(path.join(r, ".git"), { recursive: true });
      fs.writeFileSync(path.join(r, "package.json"), JSON.stringify({ name }));
    }
    // A canonical units[] declaration trips the promotion gate -> siblings are
    // suppressed to UNCONFIGURED_SIBLING (rather than promoted to units).
    const workdir = path.join(parent, "workdir");
    fs.mkdirSync(path.join(workdir, "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(workdir, "platform-map.json"),
      JSON.stringify({ units: [{ name: "pkg", path: "pkg" }] }),
    );

    const pm = await map(workdir);
    const unconfigured = pm.diagnostics.filter(
      (d) => d.code === "UNCONFIGURED_SIBLING",
    );
    assert.equal(unconfigured.length, 2);
    // Bucket-2 parity: neither sibling is promoted to a unit.
    assert.equal(
      pm.units.some((u) => u.name === "alpha-repo" || u.name === "zulu-repo"),
      false,
    );
    // Lex-by-name order (DETR-01): alpha before zulu in the serialized output.
    assert.deepEqual(
      unconfigured.map((d) => d.path),
      ["../alpha-repo", "../zulu-repo"],
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// ── DETR-02 sweep across the committed parity fixtures ───────────────────────
// The serializer is the sole sort site; two invocations over the same tree must
// be byte-identical (the multi-repo temp-tree determinism is asserted in its own
// case above).
test("map() output is byte-identical across two invocations for every committed parity fixture (DETR-02)", async () => {
  for (const root of [monorepoTurbo, syntheticSpecEngine]) {
    assert.equal(
      toJSON(await map(root)),
      toJSON(await map(root)),
      `non-deterministic output for ${path.basename(root)}`,
    );
  }
});
