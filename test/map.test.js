// CFG-03/CFG-09/SEC-01: map() end-to-end — single-repo assembly, MapOptions
// caller-unit injection, adapter toggles, determinism, and the only-throw
// contract (RootNotFoundError). Plain ESM .js importing the already-built
// dist/ (D-06) — runs unmodified under `node --test` and `bun test` (D-05).
//
// Authored in plan 02-01 Task 1 as the failing e2e that drives Task 3: until
// map() is exported from dist/index.mjs these assertions fail (map undefined).

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { map, RootNotFoundError } from "../dist/index.mjs";
import { toJSON } from "../dist/internal/serialize.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const singleRepo = path.join(fixturesDir, "single-repo");

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

test("map() injects MapOptions.units as source \"caller\"", async () => {
  const pm = await map(singleRepo, { units: [{ name: "x", path: "x" }] });
  const unit = pm.units.find((u) => u.name === "x");
  assert.ok(unit, "expected injected unit 'x' to be present");
  assert.ok(
    unit.sources.includes("caller"),
    `expected sources to include "caller", got ${JSON.stringify(unit.sources)}`,
  );
});
