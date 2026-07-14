// CFG-08: the pure merge() precedence reducer. First-writer-wins per field
// (input is precedence-ordered, high first), genuine disagreement on an
// already-set field -> one CONFIG_CONFLICT naming BOTH sources + BOTH values
// (existing kept), a lower-precedence source filling an UNSET field -> silent
// gap-fill, sources[] accumulates every contributor in input order, and the
// sibling-promotion gate turns provisional candidates into either real units
// or UNCONFIGURED_SIBLING diagnostics depending on canonicalDeclaredUnits.
//
// Plain ESM .js importing the built dist/merge.mjs (D-06) — the determinism
// (shuffle) assertion routes through toJSON (serialize.ts is the sole sort
// site; merge itself never sorts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { merge } from "../dist/merge.mjs";
import { toJSON } from "../dist/internal/serialize.mjs";

function res(source, partialUnits, diagnostics = []) {
  return { source, result: { partialUnits, edges: [], diagnostics } };
}

function wrap(m) {
  return toJSON({
    name: "x",
    root: ".",
    mode: "monorepo",
    units: m.units,
    edges: [],
    diagnostics: m.diagnostics,
    schemaVersion: 1,
  });
}

// ── CONFIG_CONFLICT: genuine disagreement on an already-set field ──────────

test("two sources disagreeing on path -> one CONFIG_CONFLICT naming both sources and both values; existing kept", () => {
  const { units, diagnostics } = merge(
    [
      res("canonical", [
        { name: "svc-api", path: "../acme-api", kind: "repo", source: "canonical" },
      ]),
      res("spec-engine", [
        { name: "svc-api", path: "members/api", kind: "repo", source: "spec-engine" },
      ]),
    ],
    false,
  );

  assert.equal(units.length, 1);
  assert.equal(units[0].path, "../acme-api"); // higher-precedence value kept

  const conflicts = diagnostics.filter((d) => d.code === "CONFIG_CONFLICT");
  assert.equal(conflicts.length, 1);
  const msg = conflicts[0].message;
  assert.ok(msg.includes("canonical"), `message names existing source: ${msg}`);
  assert.ok(msg.includes("spec-engine"), `message names incoming source: ${msg}`);
  assert.ok(msg.includes("../acme-api"), `message names existing value: ${msg}`);
  assert.ok(msg.includes("members/api"), `message names incoming value: ${msg}`);

  assert.deepEqual(units[0].sources, ["canonical", "spec-engine"]);
});

// ── silent gap-fill: lower-precedence source fills an UNSET field ───────────

test("a lower-precedence source filling an unset field writes it with no conflict", () => {
  const { units, diagnostics } = merge(
    [
      res("canonical", [
        { name: "svc", path: "svc", kind: "repo", source: "canonical" },
      ]),
      res("dark-factory", [
        { name: "svc", path: "svc", kind: "repo", ref: "main", source: "dark-factory" },
      ]),
    ],
    false,
  );

  assert.equal(units.length, 1);
  assert.equal(units[0].ref, "main"); // gap-filled by lower precedence
  assert.equal(
    diagnostics.filter((d) => d.code === "CONFIG_CONFLICT").length,
    0,
  );
  assert.deepEqual(units[0].sources, ["canonical", "dark-factory"]);
});

// ── sources[] accumulates every contributor in precedence (input) order ────

test("sources[] accumulates every contributing source in input order", () => {
  const { units } = merge(
    [
      res("canonical", [{ name: "u", path: "u", kind: "repo", source: "canonical" }]),
      res("dark-factory", [{ name: "u", path: "u", kind: "repo", source: "dark-factory" }]),
      res("workspace", [{ name: "u", path: "u", kind: "repo", source: "workspace" }]),
    ],
    false,
  );
  assert.equal(units.length, 1);
  assert.deepEqual(units[0].sources, ["canonical", "dark-factory", "workspace"]);
});

// ── promotion gate: provisional + canonicalDeclaredUnits === true ──────────

test("a provisional candidate with declared canonical units[] and no prior claim -> UNCONFIGURED_SIBLING diagnostic, not a unit", () => {
  const { units, diagnostics } = merge(
    [
      res("siblings", [
        {
          name: "sib",
          path: "../sib",
          kind: "repo",
          source: "siblings",
          provisional: true,
        },
      ]),
    ],
    true,
  );
  assert.equal(units.length, 0);
  const d = diagnostics.filter((x) => x.code === "UNCONFIGURED_SIBLING");
  assert.equal(d.length, 1);
});

// ── promotion gate: provisional + canonicalDeclaredUnits === false ─────────

test("a provisional candidate with no declared canonical units[] is promoted to a real unit", () => {
  const { units, diagnostics } = merge(
    [
      res("siblings", [
        {
          name: "sib",
          path: "../sib",
          kind: "repo",
          source: "siblings",
          provisional: true,
        },
      ]),
    ],
    false,
  );
  assert.equal(units.length, 1);
  assert.equal(units[0].name, "sib");
  assert.equal(
    diagnostics.filter((x) => x.code === "UNCONFIGURED_SIBLING").length,
    0,
  );
});

// ── promotion gate: provisional confirming an already-claimed name ─────────

test("a provisional candidate whose name a higher source already claimed confirms it (merges, no diagnostic)", () => {
  const { units, diagnostics } = merge(
    [
      res("canonical", [{ name: "svc", path: "svc", kind: "repo", source: "canonical" }]),
      res("siblings", [
        { name: "svc", path: "svc", kind: "repo", source: "siblings", provisional: true },
      ]),
    ],
    true,
  );
  assert.equal(units.length, 1);
  assert.equal(
    diagnostics.filter((x) => x.code === "UNCONFIGURED_SIBLING").length,
    0,
  );
  assert.deepEqual(units[0].sources, ["canonical", "siblings"]);
});

// ── adapter-level diagnostics pass through ─────────────────────────────────

test("merge appends each result's own diagnostics", () => {
  const { diagnostics } = merge(
    [
      res(
        "spec-engine",
        [],
        [{ code: "MALFORMED_CONFIG", severity: "warning", message: "bad member config" }],
      ),
    ],
    false,
  );
  assert.equal(
    diagnostics.filter((d) => d.code === "MALFORMED_CONFIG").length,
    1,
  );
});

// ── DETR: order-independence within a single adapter result ────────────────

test("shuffling partialUnits within one adapter result produces byte-identical merged output", () => {
  const mk = (order) =>
    res(
      "workspace",
      order.map((n) => ({
        name: n,
        path: n,
        kind: "workspace-package",
        source: "workspace",
      })),
    );

  const forward = merge([mk(["alpha", "beta", "gamma"])], false);
  const reversed = merge([mk(["gamma", "beta", "alpha"])], false);
  const shuffled = merge([mk(["beta", "gamma", "alpha"])], false);

  assert.equal(wrap(forward), wrap(reversed));
  assert.equal(wrap(reversed), wrap(shuffled));
});
