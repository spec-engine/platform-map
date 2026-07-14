// MODEL-02/SEC-03: censusSignals — the map-owned per-unit filesystem +
// package.json census. Plain ESM .js importing the already-built
// dist/signals.mjs (D-06) — runs unmodified under `node --test` and
// `bun test` (D-05). Asserted against committed static fixtures under
// test/fixtures/signals (no .git needed).

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { censusSignals } from "../dist/signals.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const signalsDir = path.join(here, "fixtures", "signals");

test("censusSignals reads the full package.json + fs fact set", () => {
  const { signals } = censusSignals(path.join(signalsDir, "rich-pkg"));
  assert.equal(signals.private, true);
  assert.equal(signals.hasExports, true);
  assert.equal(signals.hasBin, true);
  assert.equal(signals.hasStartScript, true);
  assert.equal(signals.packageName, "rich-pkg");
  assert.equal(signals.hasDockerfile, true);
  assert.equal(signals.hasDeployConfig, true);
  assert.equal(signals.packageManager, "pnpm");
  assert.deepEqual([...signals.languages].sort(), ["js", "ts"]);
});

test("censusSignals omits absent facts entirely (never false) — MODEL-02", () => {
  const { signals } = censusSignals(path.join(signalsDir, "plain"));
  // package.json has no name/private/exports/bin/start; only a .go file.
  assert.equal(Object.hasOwn(signals, "private"), false);
  assert.equal(Object.hasOwn(signals, "hasExports"), false);
  assert.equal(Object.hasOwn(signals, "hasBin"), false);
  assert.equal(Object.hasOwn(signals, "hasStartScript"), false);
  assert.equal(Object.hasOwn(signals, "packageName"), false);
  assert.equal(Object.hasOwn(signals, "hasDockerfile"), false);
  assert.equal(Object.hasOwn(signals, "hasDeployConfig"), false);
  assert.equal(Object.hasOwn(signals, "packageManager"), false);
  assert.deepEqual(signals.languages, ["go"]);
});

test("censusSignals drops an invalid package name but keeps every other signal (SEC-03)", () => {
  const { signals, diagnostics } = censusSignals(
    path.join(signalsDir, "bad-name"),
  );
  assert.equal(Object.hasOwn(signals, "packageName"), false);
  assert.deepEqual(signals.languages, ["py"]);
  const malformed = diagnostics.filter((d) => d.code === "MALFORMED_CONFIG");
  assert.equal(malformed.length, 1);
  assert.match(malformed[0].message, /invalid package name dropped: Has Space/);
});

test("censusSignals maps each lockfile to its package manager", () => {
  assert.equal(
    censusSignals(path.join(signalsDir, "rich-pkg")).signals.packageManager,
    "pnpm",
  );
  assert.equal(
    censusSignals(path.join(signalsDir, "lock-yarn")).signals.packageManager,
    "yarn",
  );
  assert.equal(
    censusSignals(path.join(signalsDir, "lock-npm")).signals.packageManager,
    "npm",
  );
  assert.equal(
    censusSignals(path.join(signalsDir, "lock-bun")).signals.packageManager,
    "bun",
  );
});

test("censusSignals omits packageManager and languages for a bare directory", () => {
  const { signals } = censusSignals(path.join(signalsDir, "empty"));
  assert.equal(Object.hasOwn(signals, "packageManager"), false);
  assert.equal(Object.hasOwn(signals, "languages"), false);
});

test("censusSignals never sets a signal to a literal false", () => {
  const { signals } = censusSignals(path.join(signalsDir, "plain"));
  for (const value of Object.values(signals)) {
    assert.notEqual(value, false);
  }
});
