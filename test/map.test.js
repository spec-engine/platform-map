// CFG-03/CFG-09/SEC-01: map() end-to-end — single-repo assembly, MapOptions
// caller-unit injection, adapter toggles, determinism, and the only-throw
// contract (RootNotFoundError). Plain ESM .js importing the already-built
// dist/ (D-06) — runs unmodified under `node --test` and `bun test` (D-05).
//
// Authored in plan 02-01 Task 1 as the failing e2e that drives Task 3: until
// map() is exported from dist/index.mjs these assertions fail (map undefined).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { map, RootNotFoundError } from "../dist/index.mjs";
import { toJSON } from "../dist/internal/serialize.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const singleRepo = path.join(fixturesDir, "single-repo");
const monorepoPnpm = path.join(fixturesDir, "monorepo-pnpm");

// ── CFG-03: single-repo happy path ─────────────────────────────────────────

test("map() on a single-repo tree returns a deterministic PlatformMap", async () => {
  const pm = await map(singleRepo);
  assert.equal(pm.schemaVersion, 1);
  assert.equal(pm.mode, "single-repo");
  assert.equal(pm.name, "single-repo");
  assert.deepEqual(pm.edges, []);
  assert.ok(Array.isArray(pm.units));
  assert.ok(Array.isArray(pm.diagnostics));
});

// ── CFG-09: caller-injected units enter as source:"caller" ─────────────────

test('map() injects MapOptions.units as source "caller"', async () => {
  const pm = await map(singleRepo, { units: [{ name: "x", path: "x" }] });
  const unit = pm.units.find((u) => u.name === "x");
  assert.ok(unit, "expected injected unit 'x' to be present");
  assert.ok(
    unit.sources.includes("caller"),
    `expected sources to include "caller", got ${JSON.stringify(unit.sources)}`,
  );
  assert.equal(unit.role, "unknown"); // role is Phase 3; seeded "unknown" here
  assert.equal(unit.ref, null);
});

// ── T-02-01: an injected path escaping root is dropped + diagnosed ─────────

test("map() drops an injected unit whose path escapes root with UNIT_PATH_ESCAPE", async () => {
  const pm = await map(singleRepo, {
    units: [{ name: "evil", path: "../../../../etc" }],
  });
  assert.equal(
    pm.units.some((u) => u.name === "evil"),
    false,
    "escaping injected unit must not be present",
  );
  assert.ok(
    pm.diagnostics.some((d) => d.code === "UNIT_PATH_ESCAPE"),
    "expected a UNIT_PATH_ESCAPE diagnostic",
  );
});

// ── CFG-09: adapter toggle runs cleanly (no adapters registered yet) ───────

test("map() honors a MapOptions.adapters disable toggle without error", async () => {
  await assert.doesNotReject(() =>
    map(singleRepo, { adapters: { siblings: false } }),
  );
});

// ── Determinism: byte-identical across repeated calls ──────────────────────

test("map() output is byte-identical across two invocations", async () => {
  const a = toJSON(await map(singleRepo));
  const b = toJSON(await map(singleRepo));
  assert.equal(a, b);
});

// ── CFG-06: monorepo e2e — workspace-package units + fs signal census ──────

test("map() enumerates workspace-package units with signals for a monorepo", async () => {
  const pm = await map(monorepoPnpm);
  assert.equal(pm.mode, "monorepo");

  const names = pm.units.map((u) => u.name);
  assert.deepEqual(names, [
    "apps/app-a",
    "packages/bad-name",
    "packages/nested-mono",
    "packages/pkg-a",
  ]);
  for (const unit of pm.units) {
    assert.equal(unit.kind, "workspace-package");
    assert.deepEqual(unit.sources, ["workspace"]);
    assert.equal(unit.role, "unknown");
  }

  // pkg-a carries the full package.json + fs signal census.
  const pkgA = pm.units.find((u) => u.name === "packages/pkg-a");
  assert.equal(pkgA.signals.packageName, "@scope/pkg-a");
  assert.equal(pkgA.signals.private, true);
  assert.equal(pkgA.signals.hasExports, true);
  assert.equal(pkgA.signals.hasBin, true);
  assert.equal(pkgA.signals.hasStartScript, true);
  assert.equal(pkgA.signals.hasDockerfile, true);
  assert.deepEqual([...pkgA.signals.languages].sort(), ["js", "ts"]);
});

test("map() keeps a unit with an invalid package name and emits MALFORMED_CONFIG (SEC-03)", async () => {
  const pm = await map(monorepoPnpm);
  const badName = pm.units.find((u) => u.name === "packages/bad-name");
  assert.ok(badName, "the unit with an invalid package name is still present");
  assert.equal(Object.hasOwn(badName.signals, "packageName"), false);
  assert.ok(
    pm.diagnostics.some(
      (d) => d.code === "MALFORMED_CONFIG" && /Has Space/.test(d.message ?? ""),
    ),
    "expected a MALFORMED_CONFIG diagnostic for the invalid package name",
  );
});

test("map() recurses into a nested monorepo (DET-02) with workspace-only children", async () => {
  const pm = await map(monorepoPnpm);
  const nested = pm.units.find((u) => u.name === "packages/nested-mono");
  assert.ok(nested, "nested monorepo unit present");
  assert.equal(nested.mode, "monorepo");
  assert.equal(nested.units.length, 1);
  const [leaf] = nested.units;
  assert.equal(leaf.name, "packages/leaf");
  assert.equal(leaf.kind, "workspace-package");
  // Nested children come ONLY from workspace expansion — never phantom
  // sibling/DF/SE sub-units at any nested level.
  assert.deepEqual(leaf.sources, ["workspace"]);
});

test("map() surfaces UNMATCHED_PATTERN (not a throw) when a workspace glob matches nothing", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-map-"));
  try {
    fs.writeFileSync(
      path.join(tempRoot, "pnpm-workspace.yaml"),
      "packages:\n  - 'does-not-exist/*'\n",
    );
    let pm;
    await assert.doesNotReject(async () => {
      pm = await map(tempRoot);
    });
    assert.equal(pm.mode, "monorepo");
    assert.ok(
      pm.diagnostics.some((d) => d.code === "UNMATCHED_PATTERN"),
      "expected an UNMATCHED_PATTERN diagnostic",
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("map() monorepo output is byte-identical across two invocations", async () => {
  const a = toJSON(await map(monorepoPnpm));
  const b = toJSON(await map(monorepoPnpm));
  assert.equal(a, b);
});

// ── SEC-01: nonexistent root is the only throw path so far ─────────────────

test("map() on a nonexistent root rejects with RootNotFoundError", async () => {
  await assert.rejects(
    () => map(path.join(fixturesDir, "does-not-exist")),
    RootNotFoundError,
  );
});
