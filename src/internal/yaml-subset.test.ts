import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePnpmWorkspacePackages } from "./yaml-subset.ts";

test("reads the packages block list, with quotes and comments", () => {
  const text = [
    "# workspace",
    "packages:",
    "  - 'packages/*'   # libs",
    '  - "apps/*"',
    "  - '!**/test/**'",
    "",
    "catalog:",
    "  react: 19",
  ].join("\n");
  assert.deepEqual(parsePnpmWorkspacePackages(text), {
    globs: ["packages/*", "apps/*", "!**/test/**"],
    diagnostics: [],
  });
});

test("no packages key means no globs; an inline list is reported as malformed", () => {
  assert.deepEqual(parsePnpmWorkspacePackages("catalog: {}\n"), {
    globs: [],
    diagnostics: [],
  });
  const r = parsePnpmWorkspacePackages("packages: [a, b]\n");
  assert.deepEqual(r.globs, []);
  assert.equal(r.diagnostics[0]?.code, "MALFORMED_FILE");
});
