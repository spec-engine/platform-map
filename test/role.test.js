// GRAPH-05/MODEL-03/MODEL-04: deriveRole (the standalone, replayable pure
// classifier) + applyRoles (the recursive, override-honoring walker). Plain ESM
// .js importing the built dist/role.mjs (D-06) — runs unmodified under
// `node --test` AND `bun test` (D-05).
//
// Authored RED in plan 03-03 Task 1: until src/role.ts is written + built to
// dist/role.mjs these assertions fail (module import missing). It encodes the
// DESIGN §4 top-down first-match rule table, the absent-signal-no-vote honesty
// (MODEL-02: undefined degree is NOT 0), applyRoles recursion at all depths, and
// canonical overrides beating derivation (MODEL-04).

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRoles, deriveRole } from "../dist/role.mjs";

/** Minimal workspace-package Unit literal for applyRoles tests. */
function unit(name, signals, children = []) {
  return {
    name,
    path: name,
    kind: "workspace-package",
    mode: "single-repo",
    ref: null,
    units: children,
    signals,
    role: "unknown",
    sources: ["pnpm-workspace.yaml"],
  };
}

// ── deriveRole rule table (DESIGN §4, top-down first match) ──────────────────

test("rule 1: deploy/runtime markers -> app (each marker independently)", () => {
  assert.equal(deriveRole({ hasDockerfile: true }), "app");
  assert.equal(deriveRole({ hasDeployConfig: true }), "app");
  assert.equal(deriveRole({ hasStartScript: true }), "app");
});

test("rule 1 wins over later library-shaped signals", () => {
  // hasExports + inDegree would vote library, but the app marker fires first.
  assert.equal(
    deriveRole({
      hasStartScript: true,
      hasExports: true,
      workspaceInDegree: 3,
    }),
    "app",
  );
});

test("rule 2: workspaceInDegree > 0 -> library", () => {
  assert.equal(deriveRole({ workspaceInDegree: 1 }), "library");
  assert.equal(
    deriveRole({ workspaceInDegree: 5, hasExports: false }),
    "library",
  );
});

test("rule 3: exports-shaped, private, no start script -> library", () => {
  assert.equal(
    deriveRole({ hasExports: true, private: true, workspaceInDegree: 0 }),
    "library",
  );
  // private absent (never asserted false by the census) still passes private !== false.
  assert.equal(
    deriveRole({ hasExports: true, workspaceInDegree: 0 }),
    "library",
  );
});

test("rule 4: pure sink (in 0, out > 0, no exports) -> app", () => {
  assert.equal(
    deriveRole({
      workspaceInDegree: 0,
      workspaceOutDegree: 2,
      hasExports: false,
    }),
    "app",
  );
});

test("rule 5: no discriminating signal -> unknown", () => {
  assert.equal(deriveRole({}), "unknown");
  assert.equal(
    deriveRole({ workspaceInDegree: 0, workspaceOutDegree: 0 }),
    "unknown",
  );
});

// ── absent-signal honesty (MODEL-02: undefined degree is NOT 0) ──────────────

test("absent workspaceInDegree skips rules 2 AND 4 (undefined is not 0)", () => {
  // out-degree present, exports false, no app markers, but inDegree UNDEFINED:
  // rule 2 skipped (needs !== undefined), rule 4 skipped (needs === 0). If
  // undefined were treated as 0, rule 4 would wrongly return "app".
  assert.equal(
    deriveRole({ workspaceOutDegree: 2, hasExports: false }),
    "unknown",
  );
});

test("absent workspaceOutDegree skips rule 4", () => {
  // inDegree 0, no out-degree signal, no exports, no app markers -> unknown.
  assert.equal(
    deriveRole({ workspaceInDegree: 0, hasExports: false }),
    "unknown",
  );
});

// ── applyRoles: recursion at all depths + overrides win (MODEL-04) ───────────

test("applyRoles sets role at every depth from derived signals", () => {
  const shared = unit("root/shared", { workspaceInDegree: 1 }); // rule 2 -> library
  const app = unit("root/app", { hasStartScript: true }); // rule 1 -> app
  const container = unit("root", {}, [shared, app]); // rule 5 -> unknown

  applyRoles([container]);

  assert.equal(container.role, "unknown");
  assert.equal(shared.role, "library");
  assert.equal(app.role, "app");
});

test("applyRoles: canonical overrides[name].role beats derivation at any depth", () => {
  const shared = unit("packages/shared", { workspaceInDegree: 1 }); // derives library
  const nestedApp = unit("packages/svc", { hasStartScript: true }); // derives app
  const container = unit("root", {}, [shared, nestedApp]);

  applyRoles([container], {
    "packages/shared": { role: "app" },
    "packages/svc": { role: "library" },
  });

  // Overrides win over the derived roles at every depth.
  assert.equal(shared.role, "app");
  assert.equal(nestedApp.role, "library");
  // A unit with no override still derives normally.
  assert.equal(container.role, "unknown");
});

test("applyRoles: a stale override key naming no unit is inert (no throw, no effect)", () => {
  const shared = unit("packages/shared", { workspaceInDegree: 1 });
  // map() already warns stale keys; applyRoles must not throw on them.
  assert.doesNotThrow(() =>
    applyRoles([shared], { "packages/ghost": { role: "app" } }),
  );
  assert.equal(shared.role, "library");
});
