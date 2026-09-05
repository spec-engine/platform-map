import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rm, tmpDir, write } from "../test/helpers.ts";
import { describeRepo } from "./packages.ts";

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "fixtures",
);

test("a monorepo lists every package its globs match, with names and declared deps", () => {
  const facts = describeRepo(path.join(fixtures, "monorepo-edges"), "edges");
  assert.equal(facts.mode, "monorepo");
  assert.deepEqual(
    facts.packages.map((p) => [p.path, p.packageName, p.deps]),
    [
      ["apps/web", "web", ["@scope/lib", "@scope/util", "react"]],
      ["packages/lib", "@scope/lib", []],
      ["packages/util", "@scope/util", []],
    ],
  );
  assert.equal(facts.packageManager, undefined); // no lockfile in the fixture
});

test("a single repo reports its own name, deps, and lockfile-derived package manager", () => {
  const dir = tmpDir();
  try {
    write(path.join(dir, "package.json"), {
      name: "@x/app",
      dependencies: { a: "1" },
      devDependencies: { b: "1" },
      peerDependencies: { c: "1" },
    });
    write(path.join(dir, "yarn.lock"), "");
    const facts = describeRepo(dir, "app");
    assert.equal(facts.mode, "single-repo");
    assert.equal(facts.packageName, "@x/app");
    assert.equal(facts.packageManager, "yarn");
    assert.deepEqual(facts.deps, ["a", "b", "c"]);
    assert.deepEqual(facts.packages, []);
  } finally {
    rm(dir);
  }
});

test("an invalid package name is dropped; a broken package.json is a warning, not a throw", () => {
  const dir = tmpDir();
  try {
    write(path.join(dir, "package.json"), { name: "Not Valid!" });
    assert.equal(describeRepo(dir, "x").packageName, undefined);
    write(path.join(dir, "package.json"), "{");
    const facts = describeRepo(dir, "x");
    assert.equal(facts.diagnostics[0]?.code, "MALFORMED_FILE");
    assert.equal(facts.diagnostics[0]?.severity, "warning");
  } finally {
    rm(dir);
  }
});

test("a workspace glob that matches nothing is reported as info", () => {
  const dir = tmpDir();
  try {
    write(path.join(dir, "package.json"), {
      workspaces: ["packages/*", "nothing/*"],
    });
    write(path.join(dir, "packages", "a", "package.json"), { name: "a" });
    const facts = describeRepo(dir, "m");
    assert.deepEqual(
      facts.packages.map((p) => p.path),
      ["packages/a"],
    );
    assert.deepEqual(
      facts.diagnostics.map((d) => [d.severity, d.code]),
      [["info", "UNMATCHED_PATTERN"]],
    );
  } finally {
    rm(dir);
  }
});
