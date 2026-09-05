// end-to-end role-derivation validation over the committed
// `synthetic-spec-engine` fixture — the tree that actually satisfies the
// documented role anchor (engine/shared/tracker -> library, webapp -> app).
//
// Plain ESM .js importing the already-built dist/ — runs unmodified
// under `node --test` AND `bun test`. This drives deriveRole through
// the full map() pipeline (census -> edges -> degrees -> applyRoles), so a
// future rule/degree regression is caught at the label AND at the driving
// signals, not just the final role.
//
// Why the synthetic fixture and not the live ../spec-engine repo: the live
// repo's real engine<->webapp dependency makes `webapp` derive to library
// (rules 2/3) and forms a 2-cycle, so it cannot serve as the documented
// example anchor. The deriveRole RULES are correct; only the original design
// note's example was stale. This test validates the rules against a fixture that DOES
// satisfy the anchor.

import assert from "node:assert/strict";
import { test } from "node:test";
import { map } from "../dist/index.mjs";
import { toJSON } from "../dist/internal/serialize.mjs";

// Relative to the repo root (node --test / bun test run from the package root),
// matching the documented pattern. Passing a relative root keeps the
// serialized `root` field relative too, so the no-absolute-path guard below is
// a real assertion rather than an echo of the caller's input path.
const specEngine = "test/fixtures/synthetic-spec-engine";

// ── documented role anchor: the exact roleByName the fixture must yield ────────

test("map(synthetic-spec-engine) derives the documented role anchor", async () => {
  const pm = await map(specEngine);
  assert.equal(pm.mode, "monorepo");

  const roleByName = Object.fromEntries(
    pm.units.map((u) => [u.name.split("/").pop(), u.role]),
  );
  // engine:  rule 3 — hasExports + private + no start script + inDegree 0.
  // shared:  rule 2 — workspaceInDegree > 0 (depended on by engine + webapp).
  // tracker: rule 2 — workspaceInDegree > 0 (depended on by engine).
  // webapp:  rule 1 — hasStartScript (deploy/runtime marker wins first).
  assert.deepEqual(roleByName, {
    engine: "library",
    shared: "library",
    tracker: "library",
    webapp: "app",
  });
});

// ── The three documented edges (Unit.name paths) ─────────────────────────────

test("map(synthetic-spec-engine) forms the three documented workspace edges", async () => {
  const pm = await map(specEngine);
  const edgeSet = new Set(pm.edges.map((e) => `${e.from}=>${e.to}`));
  assert.ok(edgeSet.has("packages/engine=>packages/shared"), "engine->shared");
  assert.ok(
    edgeSet.has("packages/engine=>packages/tracker"),
    "engine->tracker",
  );
  assert.ok(edgeSet.has("packages/webapp=>packages/shared"), "webapp->shared");
  assert.equal(pm.edges.length, 3, "exactly three edges, no phantom edges");
});

// ── The driving degree signals behind the labels (catch rule regressions) ────

test("map(synthetic-spec-engine) exposes the degree signals that drive the roles", async () => {
  const pm = await map(specEngine);
  const byName = Object.fromEntries(
    pm.units.map((u) => [u.name.split("/").pop(), u]),
  );
  // engine drives rule 3: pure source, out=2 in=0 -> library (not rule 4 app,
  // because hasExports is true).
  assert.equal(byName.engine.signals.workspaceOutDegree, 2);
  assert.equal(byName.engine.signals.workspaceInDegree, 0);
  // shared drives rule 2: depended on by engine + webapp -> inDegree 2.
  assert.ok(
    byName.shared.signals.workspaceInDegree > 0,
    "shared is depended on",
  );
  assert.equal(byName.shared.signals.workspaceInDegree, 2);
});

// ── byte-identical toJSON across two invocations, no leaked paths ────

test("map(synthetic-spec-engine) is byte-identical across two invocations", async () => {
  const a = toJSON(await map(specEngine));
  const b = toJSON(await map(specEngine));
  assert.equal(a, b);
  // No absolute paths leak into the serialized output (guard): the
  // process cwd (repo root) must never appear in the deterministic output.
  assert.ok(!a.includes(process.cwd()), "no absolute path in output");
});
