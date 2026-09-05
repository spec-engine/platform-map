// segment-based glob matcher. Plain ESM .js importing the
// already-built dist/ — runs unmodified under `node --test` and
// `bun test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { matchGlob } from "../dist/internal/glob.mjs";
import {
  candidatePaths as adversarialCandidatePaths,
  patterns as adversarialPatterns,
} from "./fixtures/adversarial-glob/corpus.js";

test("matches a literal-prefix single-* pattern against a candidate set", () => {
  const result = matchGlob(
    ["packages/*"],
    ["packages/a", "packages/b", "apps/x"],
  );
  assert.deepEqual(result.matched, ["packages/a", "packages/b"]);
  assert.deepEqual(result.diagnostics, []);
});

test("** matches zero, one, and many segments", () => {
  const result = matchGlob(["**"], ["a", "a/b", "a/b/c"]);
  assert.deepEqual(result.matched, ["a", "a/b", "a/b/c"]);
  assert.deepEqual(result.diagnostics, []);
});

test("!negation excludes a previously-matched candidate, in declaration order", () => {
  const result = matchGlob(
    ["packages/*", "!packages/internal"],
    ["packages/a", "packages/internal", "packages/b"],
  );
  assert.deepEqual(result.matched, ["packages/a", "packages/b"]);
  assert.deepEqual(result.diagnostics, []);
});

test("an unmatched inclusion pattern emits an UNMATCHED_PATTERN diagnostic", () => {
  const result = matchGlob(["does-not-exist/*"], ["packages/a"]);
  assert.deepEqual(result.matched, []);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, "UNMATCHED_PATTERN");
  assert.equal(result.diagnostics[0].severity, "warning");
  assert.equal(result.diagnostics[0].path, "does-not-exist/*");
});

test("an unmatched negation pattern does NOT emit an UNMATCHED_PATTERN diagnostic", () => {
  const result = matchGlob(
    ["packages/*", "!packages/nonexistent"],
    ["packages/a"],
  );
  assert.deepEqual(result.matched, ["packages/a"]);
  assert.deepEqual(result.diagnostics, []);
});

test("matched is sorted in plain code-unit order regardless of candidate input order", () => {
  const result = matchGlob(["*"], ["b", "a", "c"]);
  assert.deepEqual(result.matched, ["a", "b", "c"]);
});

test("intra-segment * wildcard matches partial segment names", () => {
  const result = matchGlob(
    ["packages/eng*"],
    ["packages/engine", "packages/other"],
  );
  assert.deepEqual(result.matched, ["packages/engine"]);
});

test("the adversarial corpus (deeply nested **, very long patterns, evil wildcard segments) completes well under 1000ms", () => {
  const start = performance.now();
  const result = matchGlob(adversarialPatterns, adversarialCandidatePaths);
  const elapsed = performance.now() - start;
  assert.ok(
    elapsed < 1000,
    `expected adversarial corpus to resolve in under 1000ms, took ${elapsed}ms`,
  );
  // Sanity: the corpus still produces a well-formed result, not a crash/hang.
  assert.ok(Array.isArray(result.matched));
  assert.ok(Array.isArray(result.diagnostics));
});
