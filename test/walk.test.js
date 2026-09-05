// symlink-safe, depth/entry-capped directory walker. Plain ESM .js
// importing the already-built dist/ — runs unmodified under
// `node --test` and `bun test`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { walk } from "../dist/internal/walk.mjs";

function makeTempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-walk-"));
  fs.mkdirSync(path.join(root, "packages", "a"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages", "b"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "a", "index.ts"), "");
  fs.writeFileSync(path.join(root, "packages", "b", "index.ts"), "");
  fs.writeFileSync(path.join(root, "root.txt"), "");
  return root;
}

test("walk over a small tree returns entries sorted, no diagnostics under caps", () => {
  const root = makeTempTree();
  try {
    const result = walk(root, { maxDepth: 10, maxEntries: 1000 });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.entries, [
      "packages",
      "packages/a",
      "packages/a/index.ts",
      "packages/b",
      "packages/b/index.ts",
      "root.txt",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("node_modules and dot-prefixed dirs are pruned; dot-files still emitted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-walk-"));
  try {
    fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "");
    fs.mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages", "a", "node_modules"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, "packages", "a", "index.ts"), "");
    fs.writeFileSync(path.join(root, ".gitignore"), "");

    const result = walk(root, { maxDepth: 10, maxEntries: 1000 });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.entries, [
      ".gitignore",
      "packages",
      "packages/a",
      "packages/a/index.ts",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pruned dirs do not consume the maxEntries budget", () => {
  function makeDirent(name, isDir) {
    return {
      name,
      isSymbolicLink: () => false,
      isDirectory: () => isDir,
    };
  }
  const readdir = (dir) => {
    if (dir === "/root") {
      return [
        makeDirent("node_modules", true),
        makeDirent("real-1", false),
        makeDirent("real-2", false),
      ];
    }
    if (dir === "/root/node_modules") {
      return Array.from({ length: 50 }, (_, i) => makeDirent(`dep-${i}`, true));
    }
    return [];
  };

  const result = walk("/root", { maxDepth: 10, maxEntries: 2, readdir });
  assert.deepEqual(result.entries, ["real-1", "real-2"]);
  assert.deepEqual(result.diagnostics, []);
});

test("an a->b->a symlink cycle terminates in bounded time and is never followed", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "platform-map-walk-cycle-"),
  );
  try {
    fs.mkdirSync(path.join(root, "a"));
    fs.mkdirSync(path.join(root, "b"));
    fs.writeFileSync(path.join(root, "b", "marker.txt"), "");
    // a/link-to-b -> ../b ; b/link-to-a -> ../a (the cycle)
    fs.symlinkSync(
      path.join(root, "b"),
      path.join(root, "a", "link-to-b"),
      "dir",
    );
    fs.symlinkSync(
      path.join(root, "a"),
      path.join(root, "b", "link-to-a"),
      "dir",
    );

    const start = Date.now();
    const result = walk(root, { maxDepth: 50, maxEntries: 1000 });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2000, `expected bounded completion, took ${elapsed}ms`);
    // The symlinked entries themselves are skipped entirely...
    assert.ok(!result.entries.includes("a/link-to-b"));
    assert.ok(!result.entries.includes("b/link-to-a"));
    // ...and the walk never followed the cycle to "discover" b's real
    // contents via a's symlink (or vice versa) a second time.
    assert.deepEqual(
      result.entries.filter((e) => e === "b/marker.txt"),
      ["b/marker.txt"],
    );
    assert.deepEqual(result.diagnostics, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exceeding maxEntries appends a CENSUS_TRUNCATED diagnostic and stops descending", () => {
  // Synthetic injectable readdir (Pitfall 3 seam): a wide, shallow tree of
  // more entries than maxEntries allows, no real filesystem needed.
  function makeDirent(name, isDir) {
    return {
      name,
      isSymbolicLink: () => false,
      isDirectory: () => isDir,
    };
  }
  const readdir = (dir) => {
    if (dir === "/root") {
      return Array.from({ length: 20 }, (_, i) =>
        makeDirent(`file-${i}`, false),
      );
    }
    return [];
  };

  const result = walk("/root", { maxDepth: 10, maxEntries: 5, readdir });
  assert.equal(result.entries.length, 5);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, "CENSUS_TRUNCATED");
  assert.match(result.diagnostics[0].message, /maxEntries exceeded/);
});

test("exceeding maxDepth appends a CENSUS_TRUNCATED diagnostic and stops descending that subtree", () => {
  function makeDirent(name, isDir) {
    return {
      name,
      isSymbolicLink: () => false,
      isDirectory: () => isDir,
    };
  }
  const readdir = (dir) => {
    if (dir === "/root") return [makeDirent("level1", true)];
    if (dir === "/root/level1") return [makeDirent("level2", true)];
    if (dir === "/root/level1/level2") return [makeDirent("leaf.txt", false)];
    return [];
  };

  const result = walk("/root", { maxDepth: 1, maxEntries: 1000, readdir });
  // level1 (depth 1) is visible — it's the walker discovering the entry, not
  // recursing INTO it that's capped. level1/level2 (depth 2) is also listed
  // as an entry (its presence is a fact), but the walker never descends
  // into it to discover "leaf.txt" — that's the truncation.
  assert.deepEqual(result.entries, ["level1", "level1/level2"]);
  assert.ok(!result.entries.includes("level1/level2/leaf.txt"));
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, "CENSUS_TRUNCATED");
  assert.equal(result.diagnostics[0].path, "level1/level2");
  assert.match(result.diagnostics[0].message, /maxDepth exceeded/);
});

test("a reversed/shuffled injectable readdir yields identical sorted entries", () => {
  function makeDirent(name, isDir) {
    return {
      name,
      isSymbolicLink: () => false,
      isDirectory: () => isDir,
    };
  }
  const forward = (dir) => {
    if (dir === "/root") {
      return [
        makeDirent("a", false),
        makeDirent("b", false),
        makeDirent("c", false),
      ];
    }
    return [];
  };
  const reversed = (dir) => {
    if (dir === "/root") {
      return [
        makeDirent("c", false),
        makeDirent("b", false),
        makeDirent("a", false),
      ];
    }
    return [];
  };

  const forwardResult = walk("/root", {
    maxDepth: 10,
    maxEntries: 1000,
    readdir: forward,
  });
  const reversedResult = walk("/root", {
    maxDepth: 10,
    maxEntries: 1000,
    readdir: reversed,
  });
  assert.deepEqual(forwardResult.entries, ["a", "b", "c"]);
  assert.deepEqual(reversedResult.entries, forwardResult.entries);
});
