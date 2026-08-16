// MODEL-02/SEC-03: censusSignals — the map-owned per-unit filesystem +
// package.json census. Plain ESM .js importing the already-built
// dist/signals.mjs (D-06) — runs unmodified under `node --test` and
// `bun test` (D-05). Asserted against committed static fixtures under
// test/fixtures/signals (no .git needed).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deriveRole } from "../dist/index.mjs";
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

test("an explicit private:false is recorded as a fact and defeats role rule 3", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-signals-"));
  try {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "pub-pkg", private: false, main: "index.js" }),
    );
    const { signals } = censusSignals(dir);
    assert.equal(signals.private, false);
    assert.equal(signals.hasExports, true);
    assert.notEqual(deriveRole(signals), "library");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// WR-01: the invalid-package-name diagnostic must carry the unit's
// platform-relative locus so the failure reports WHICH unit produced it and
// serialize.ts's (severity,code,path) tie-break stays total across multiple
// invalid-name diagnostics.
test("censusSignals stamps the provided locus onto an invalid-name diagnostic (WR-01)", () => {
  const { diagnostics } = censusSignals(
    path.join(signalsDir, "bad-name"),
    "packages/bad-name",
  );
  const malformed = diagnostics.find((d) => d.code === "MALFORMED_CONFIG");
  assert.ok(malformed, "expected a MALFORMED_CONFIG diagnostic");
  assert.equal(malformed.path, "packages/bad-name");
});

// DIAG-01: walk-census diagnostics (CENSUS_TRUNCATED) are re-anchored under
// the locus so nested units report platform-qualified paths.
test("censusSignals prefixes a CENSUS_TRUNCATED path with the locus (DIAG-01)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-signals-"));
  try {
    let deep = dir;
    for (let i = 1; i <= 17; i++) deep = path.join(deep, `d${i}`);
    fs.mkdirSync(deep, { recursive: true });
    const { diagnostics } = censusSignals(dir, "mono/packages/app");
    const truncated = diagnostics.find((d) => d.code === "CENSUS_TRUNCATED");
    assert.ok(truncated, "expected a CENSUS_TRUNCATED diagnostic");
    assert.ok(
      truncated.path.startsWith("mono/packages/app/"),
      `expected a locus-prefixed path, got ${truncated.path}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("censusSignals leaves the invalid-name diagnostic path unset when no locus is given", () => {
  const { diagnostics } = censusSignals(path.join(signalsDir, "bad-name"));
  const malformed = diagnostics.find((d) => d.code === "MALFORMED_CONFIG");
  assert.ok(malformed, "expected a MALFORMED_CONFIG diagnostic");
  assert.equal(Object.hasOwn(malformed, "path") && malformed.path, undefined);
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
