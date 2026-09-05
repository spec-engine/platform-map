// path-traversal guard. Plain ESM .js importing the already-built
// dist/ — runs unmodified under `node --test` and `bun test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWithinRoot } from "../dist/internal/path-guard.mjs";

test("resolves a path within root", () => {
  const result = resolveWithinRoot("/tmp/platform-root", "sub/dir");
  assert.equal(result.ok, true);
  assert.equal(result.relative, "sub/dir");
});

test("drops a ../../ escape with an UNIT_PATH_ESCAPE diagnostic", () => {
  const result = resolveWithinRoot("/tmp/platform-root", "../../etc");
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, "UNIT_PATH_ESCAPE");
  assert.equal(result.diagnostic.severity, "warning");
});

test("the root itself resolves to '.'", () => {
  const result = resolveWithinRoot("/tmp/platform-root", ".");
  assert.equal(result.ok, true);
  assert.equal(result.relative, ".");
});

test("an absolute candidate outside root escapes", () => {
  const result = resolveWithinRoot("/tmp/platform-root", "/etc/passwd");
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, "UNIT_PATH_ESCAPE");
});

test("never throws and never touches the filesystem (pure path math)", () => {
  assert.doesNotThrow(() =>
    resolveWithinRoot("/does/not/exist", "also/does/not/exist"),
  );
});
