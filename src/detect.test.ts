import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rm, tmpDir, write } from "../test/helpers.ts";
import { detect } from "./detect.ts";

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "fixtures",
);

test("workspace manifests are recognized in probe order", () => {
  assert.deepEqual(detect(path.join(fixtures, "monorepo-pnpm")), {
    mode: "monorepo",
    manifest: "pnpm-workspace",
    workspaceGlobs: ["packages/*", "apps/*", "!**/test/**"],
  });
  assert.equal(
    detect(path.join(fixtures, "monorepo-yarn-ws")).manifest,
    "yarn-workspaces",
  );
  assert.equal(
    detect(path.join(fixtures, "monorepo-npm-ws")).manifest,
    "npm-workspaces",
  );
  assert.equal(detect(path.join(fixtures, "monorepo-lerna")).manifest, "lerna");
});

test("a plain repo is single-repo; a platform file makes it multi-repo", () => {
  assert.deepEqual(detect(path.join(fixtures, "single-repo")), {
    mode: "single-repo",
  });
  const dir = tmpDir();
  try {
    write(path.join(dir, "platform-map.json"), { name: "p", members: [] });
    assert.deepEqual(detect(dir), { mode: "multi-repo" });
  } finally {
    rm(dir);
  }
});

test("a leaf marker alone does not change the shape", () => {
  const dir = tmpDir();
  try {
    write(path.join(dir, "platform-map.json"), { platform: "p" });
    assert.equal(detect(dir).mode, "single-repo");
  } finally {
    rm(dir);
  }
});

test("a missing directory throws", () => {
  assert.throws(() => detect(path.join(fixtures, "does-not-exist")), {
    name: "DirectoryNotFoundError",
  });
});
