// SEC-03: validatePackageName — the pure package-name guard. Plain ESM .js
// importing the already-built dist/internal/package-name.mjs (D-06) — runs
// unmodified under `node --test` and `bun test` (D-05).

import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePackageName } from "../dist/internal/package-name.mjs";

test("validatePackageName accepts a scoped name", () => {
  const result = validatePackageName("@scope/pkg");
  assert.equal(result.ok, true);
  assert.equal(result.name, "@scope/pkg");
});

test("validatePackageName accepts a plain unscoped name", () => {
  const result = validatePackageName("my-lib");
  assert.equal(result.ok, true);
  assert.equal(result.name, "my-lib");
});

test("validatePackageName accepts dotted/underscored names", () => {
  for (const name of ["a.b.c", "my_lib", "pkg0"]) {
    assert.equal(validatePackageName(name).ok, true, `expected ${name} ok`);
  }
});

test("validatePackageName rejects a name with a space", () => {
  const result = validatePackageName("Has Space");
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, "MALFORMED_CONFIG");
  assert.equal(result.diagnostic.severity, "warning");
  assert.match(
    result.diagnostic.message,
    /invalid package name dropped: Has Space/,
  );
});

test("validatePackageName rejects a traversal-shaped name", () => {
  const result = validatePackageName("../evil");
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, "MALFORMED_CONFIG");
});

test("validatePackageName rejects the empty string", () => {
  const result = validatePackageName("");
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, "MALFORMED_CONFIG");
});
