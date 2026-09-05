// pnpm-workspace.yaml regex-subset parser. Plain ESM .js importing
// the already-built dist/ — runs unmodified under `node --test` and
// `bun test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePnpmWorkspacePackages } from "../dist/internal/yaml-subset.mjs";

test("parses a simple packages: block-list, preserving declaration order incl. negation", () => {
  const { globs, diagnostics } = parsePnpmWorkspacePackages(
    "packages:\n  - 'pkg-a'\n  - 'packages/*'\n  - '!**/test/**'\n",
  );
  assert.deepEqual(globs, ["pkg-a", "packages/*", "!**/test/**"]);
  assert.deepEqual(diagnostics, []);
});

test("a packages: [a, b] flow-sequence form degrades to MALFORMED_CONFIG, never throws", () => {
  const { globs, diagnostics } =
    parsePnpmWorkspacePackages("packages: [a, b]\n");
  assert.deepEqual(globs, []);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "MALFORMED_CONFIG");
  assert.match(diagnostics[0].message, /^MALFORMED_CONFIG:/);
});

test("a quoted value containing # is not truncated as a comment", () => {
  const { globs } = parsePnpmWorkspacePackages(
    'packages:\n  - "pkg-a#weird"\n',
  );
  assert.deepEqual(globs, ["pkg-a#weird"]);
});

test("a trailing unquoted # comment is stripped", () => {
  const { globs } = parsePnpmWorkspacePackages(
    "packages:\n  - 'pkg-a' # a trailing comment\n",
  );
  assert.deepEqual(globs, ["pkg-a"]);
});

test("other pnpm settings keys are ignored without being misinterpreted", () => {
  const { globs, diagnostics } = parsePnpmWorkspacePackages(
    "onlyBuiltDependencies:\n  - foo\npackages:\n  - 'pkg-a'\ncatalog:\n  bar: 1.0.0\n",
  );
  assert.deepEqual(globs, ["pkg-a"]);
  assert.deepEqual(diagnostics, []);
});

test("no packages: key at all yields an empty glob list, no diagnostics", () => {
  const { globs, diagnostics } = parsePnpmWorkspacePackages(
    "onlyBuiltDependencies:\n  - foo\n",
  );
  assert.deepEqual(globs, []);
  assert.deepEqual(diagnostics, []);
});

test("blank/comment-only lines inside the block are skipped, not treated as dedent", () => {
  const { globs } = parsePnpmWorkspacePackages(
    "packages:\n  - 'pkg-a'\n\n  # a full-line comment\n  - 'pkg-b'\n",
  );
  assert.deepEqual(globs, ["pkg-a", "pkg-b"]);
});
