// (diagnostic half) / / / map()'s strict-
// order wiring — buildEdges -> populateDegrees -> CYCLE_SUSPECTED emission ->
// applyRoles — proven end-to-end. Plain ESM .js importing the built dist/
// artifacts; runs unmodified under `node --test` AND `bun test`.
//
// Authored RED in plan 03-03 Task 1: until map() populates degrees, emits
// CYCLE_SUSPECTED, and applies roles, these assertions fail (degrees undefined,
// roles seeded "unknown", no cycle diagnostic).
//
// The documented role anchor is proven against a SYNTHETIC spec-engine-shaped fixture
// (NOT the live ../spec-engine repo, where webapp derives to library and
// engine<->webapp is a real 2-cycle — that live-repo divergence is deferred to
// Phase 5 and flagged for the roadmap owner, not tested here).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { graph } from "../dist/graph.mjs";
import { map } from "../dist/index.mjs";
import { toJSON } from "../dist/internal/serialize.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const synthetic = path.join(here, "fixtures", "synthetic-spec-engine");

/** Finds a unit by name at any depth in a PlatformMap. */
function findUnit(units, name) {
  for (const u of units) {
    if (u.name === name) return u;
    if (u.units.length > 0) {
      const hit = findUnit(u.units, name);
      if (hit) return hit;
    }
  }
  return undefined;
}

// ── Synthetic spec-engine anchor: roles + degree population ─

test("map(synthetic): engine/shared/tracker -> library, webapp -> app", async () => {
  const pm = await map(synthetic);

  const engine = findUnit(pm.units, "packages/engine");
  const shared = findUnit(pm.units, "packages/shared");
  const tracker = findUnit(pm.units, "packages/tracker");
  const webapp = findUnit(pm.units, "packages/webapp");

  assert.ok(engine && shared && tracker && webapp, "all four units resolved");

  // engine: library via rule 3 (exports + private + no start, inDegree 0).
  assert.equal(engine.role, "library");
  // shared/tracker: library via rule 2 (something imports them).
  assert.equal(shared.role, "library");
  assert.equal(tracker.role, "library");
  // webapp: app via rule 1 (start script).
  assert.equal(webapp.role, "app");
});

test("map(synthetic): degrees populated on every workspace-package (0 included)", async () => {
  const pm = await map(synthetic);

  const shared = findUnit(pm.units, "packages/shared");
  const engine = findUnit(pm.units, "packages/engine");

  // shared is imported by engine AND webapp -> inDegree >= 1.
  assert.ok(
    shared.signals.workspaceInDegree >= 1,
    `shared inDegree expected >= 1, got ${shared.signals.workspaceInDegree}`,
  );
  // engine is imported by nothing -> inDegree EXPLICITLY 0 (presence is meaningful).
  assert.equal(engine.signals.workspaceInDegree, 0);
  // engine depends on shared + tracker -> outDegree 2.
  assert.equal(engine.signals.workspaceOutDegree, 2);
});

// ── cycles surface as CYCLE_SUSPECTED, mirror graph().cycles(), no throw ─

test("map(cyclic): one CYCLE_SUSPECTED warning per cycle, mirrors graph().cycles(), never throws", async () => {
  // Materialize a real 2-cycle monorepo in a temp dir: packages/a <-> packages/b.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-cycle-"));
  try {
    fs.writeFileSync(
      path.join(dir, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );
    const mk = (pkgDir, name, dep) => {
      fs.mkdirSync(path.join(dir, "packages", pkgDir), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "packages", pkgDir, "package.json"),
        JSON.stringify({
          name,
          dependencies: { [dep]: "workspace:*" },
        }),
      );
    };
    mk("a", "@cyc/a", "@cyc/b");
    mk("b", "@cyc/b", "@cyc/a");

    // map() must resolve (never throw) on a cyclic workspace .
    const pm = await map(dir);

    const cycleDiags = pm.diagnostics.filter(
      (d) => d.code === "CYCLE_SUSPECTED",
    );
    assert.equal(
      cycleDiags.length,
      1,
      "exactly one CYCLE_SUSPECTED diagnostic",
    );
    assert.equal(cycleDiags[0].severity, "warning");

    // The diagnostic path is the lexically-smallest cycle member, and it agrees
    // byte-for-byte with graph().cycles() (shared scc.ts).
    const cycles = graph(pm).cycles();
    assert.deepEqual(cycles, [["packages/a", "packages/b"]]);
    assert.equal(cycleDiags[0].path, cycles[0][0]);
    assert.equal(cycleDiags[0].path, "packages/a");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Determinism: degree/role/edge/diagnostic outputs order-independent ─

test("toJSON is byte-identical under shuffled unit/edge/diagnostic ordering", () => {
  const pkg = (name, signals, role) => ({
    name,
    path: name,
    kind: "workspace-package",
    mode: "single-repo",
    ref: null,
    units: [],
    signals,
    role,
    sources: ["pnpm-workspace.yaml"],
  });
  const a = pkg(
    "packages/a",
    { workspaceInDegree: 0, workspaceOutDegree: 1, hasExports: false },
    "app",
  );
  const b = pkg(
    "packages/b",
    { workspaceInDegree: 1, workspaceOutDegree: 0, hasExports: true },
    "library",
  );
  const edgeAB = {
    from: "packages/a",
    to: "packages/b",
    via: "workspace-dependency",
  };
  const diag = {
    code: "CYCLE_SUSPECTED",
    severity: "warning",
    path: "packages/a",
    message:
      "CYCLE_SUSPECTED: workspace dependency cycle among packages/a, packages/b",
  };
  const wrap = (units, edges, diagnostics) =>
    toJSON({
      name: "synthetic",
      root: ".",
      mode: "monorepo",
      units,
      edges,
      diagnostics,
      schemaVersion: 1,
    });

  const forward = wrap([a, b], [edgeAB], [diag]);
  const shuffled = wrap([b, a], [edgeAB], [diag]);

  assert.equal(forward, shuffled);
});
