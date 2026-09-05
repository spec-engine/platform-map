// direct unit tests over dist/internal/unique-names.mjs, the claim
// registry backing map()'s nested-expansion dedupe and the post-assembly
// uniqueness guard behind the types.ts Unit.name uniqueness contract.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claim,
  enforceUniqueUnitNames,
  joinLocation,
} from "../dist/internal/unique-names.mjs";

function unit(name, path, units = []) {
  return {
    name,
    path,
    kind: "workspace-package",
    mode: "single-repo",
    ref: null,
    units,
    signals: {},
    role: "unknown",
    sources: ["workspace"],
  };
}

test("claim registers a free name and reports both duplicate shapes", () => {
  const registry = new Map();
  assert.equal(claim(registry, "svc/packages/x", "svc/packages/x"), "free");
  assert.equal(
    claim(registry, "svc/packages/x", "svc/packages/x"),
    "duplicate-same-location",
  );
  assert.equal(
    claim(registry, "svc/packages/x", "elsewhere/x"),
    "duplicate-different-location",
  );
  // The first claimant's location is never overwritten.
  assert.equal(registry.get("svc/packages/x"), "svc/packages/x");
});

test("joinLocation joins platform-relative segments; a '.' parent contributes nothing", () => {
  assert.equal(joinLocation(".", "packages/x"), "packages/x");
  assert.equal(joinLocation("svc", "packages/x"), "svc/packages/x");
});

test("enforceUniqueUnitNames keeps the first unit in depth-first fold order and drops later duplicates with CONFIG_CONFLICT", () => {
  const tree = [
    unit("a", "a"),
    unit("mono", "mono", [
      unit("mono/packages/x", "packages/x"),
      unit("a", "packages/a-dup"),
    ]),
    unit("mono/packages/x", "elsewhere"),
  ];
  const diagnostics = enforceUniqueUnitNames(tree);

  assert.deepEqual(
    tree.map((u) => u.name),
    ["a", "mono"],
  );
  assert.deepEqual(
    tree[1].units.map((u) => u.name),
    ["mono/packages/x"],
  );
  assert.equal(diagnostics.length, 2);
  for (const d of diagnostics) {
    assert.equal(d.code, "CONFIG_CONFLICT");
    assert.equal(d.severity, "warning");
  }
  const dupA = diagnostics.find((d) => d.path === "a");
  assert.ok(dupA, "expected a diagnostic for the duplicate name 'a'");
  assert.match(dupA.message, /"a"/);
  assert.match(dupA.message, /mono\/packages\/a-dup/);
  const dupX = diagnostics.find((d) => d.path === "mono/packages/x");
  assert.ok(dupX, "expected a diagnostic for the duplicate nested name");
  assert.match(dupX.message, /"mono\/packages\/x"/);
  assert.match(dupX.message, /elsewhere/);
  assert.match(dupX.message, /keeps the name/);
});

test("enforceUniqueUnitNames is deterministic across repeated runs on the same shape", () => {
  const build = () => [
    unit("dup", "first"),
    unit("dup", "second"),
    unit("dup", "third"),
  ];
  const treeA = build();
  const treeB = build();
  const diagA = enforceUniqueUnitNames(treeA);
  const diagB = enforceUniqueUnitNames(treeB);
  assert.deepEqual(diagA, diagB);
  assert.deepEqual(JSON.stringify(treeA), JSON.stringify(treeB));
  assert.deepEqual(
    treeA.map((u) => u.path),
    ["first"],
  );
});

test("enforceUniqueUnitNames returns an already-unique tree untouched with zero diagnostics", () => {
  const tree = [
    unit("a", "a"),
    unit("mono", "mono", [unit("mono/packages/x", "packages/x")]),
  ];
  const before = JSON.stringify(tree);
  const diagnostics = enforceUniqueUnitNames(tree);
  assert.deepEqual(diagnostics, []);
  assert.equal(JSON.stringify(tree), before);
});
