import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { rm, tmpDir, write } from "../../test/helpers.ts";
import { walk } from "./walk.ts";

test("walk lists files and directories in a stable order, skipping node_modules, dotdirs, and symlinks", () => {
  const dir = tmpDir();
  try {
    write(path.join(dir, "b", "file.txt"), "");
    write(path.join(dir, "a", "nested", "x.ts"), "");
    write(path.join(dir, "node_modules", "dep", "index.js"), "");
    write(path.join(dir, ".git", "HEAD"), "");
    fs.symlinkSync(path.join(dir, "a"), path.join(dir, "link"), "dir");
    const r = walk(dir, { maxDepth: 10, maxEntries: 100 });
    assert.deepEqual(r.entries, [
      "a",
      "a/nested",
      "a/nested/x.ts",
      "b",
      "b/file.txt",
    ]);
    assert.deepEqual(r.diagnostics, []);
  } finally {
    rm(dir);
  }
});

test("hitting the depth or entry cap stops the walk with one SCAN_TRUNCATED diagnostic", () => {
  const dir = tmpDir();
  try {
    write(path.join(dir, "1", "2", "3", "4", "f"), "");
    const deep = walk(dir, { maxDepth: 2, maxEntries: 100 });
    assert.deepEqual(
      deep.diagnostics.map((d) => d.code),
      ["SCAN_TRUNCATED"],
    );
    for (let i = 0; i < 10; i++) write(path.join(dir, `f${i}`), "");
    const many = walk(dir, { maxDepth: 10, maxEntries: 5 });
    assert.equal(many.entries.length, 5);
    assert.equal(many.diagnostics.length, 1);
  } finally {
    rm(dir);
  }
});
