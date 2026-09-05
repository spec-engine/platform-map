// workspaceAdapter — the workspace-package enumerator. Plain
// ESM .js importing the already-built dist/adapters/workspace.mjs. The
// glob-expansion, UNMATCHED_PATTERN, and-drop branches are exercised via
// the adapter's TEST-ONLY injectable `deps` seam (mirrors the walk/scan readdir
// seams); one real-fs case runs against the committed monorepo-pnpm fixture.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { workspaceAdapter } from "../dist/adapters/workspace.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoPnpm = path.join(here, "fixtures", "monorepo-pnpm");

function ctx(mode, workspaceGlobs) {
  return { detection: { mode, workspaceGlobs }, ignore: [], options: {} };
}

test("workspaceAdapter is a no-op for a non-monorepo detection", () => {
  const result = workspaceAdapter("/anywhere", ctx("single-repo", undefined));
  assert.deepEqual(result.partialUnits, []);
  assert.deepEqual(result.edges, []);
  assert.deepEqual(result.diagnostics, []);
});

test("workspaceAdapter expands globs into workspace-package units", () => {
  const result = workspaceAdapter(
    "/root",
    ctx("monorepo", ["packages/*", "apps/*"]),
    {
      walk: () => ({
        entries: ["packages/a", "packages/b", "apps/web", "packages/a/src"],
        diagnostics: [],
      }),
      hasPackageJson: () => true,
    },
  );
  assert.deepEqual(result.partialUnits.map((u) => u.name).sort(), [
    "apps/web",
    "packages/a",
    "packages/b",
  ]);
  for (const unit of result.partialUnits) {
    assert.equal(unit.kind, "workspace-package");
    assert.equal(unit.source, "workspace");
    assert.equal(unit.path, unit.name);
  }
  assert.deepEqual(result.edges, []);
});

test("workspaceAdapter skips matched paths without a package.json", () => {
  const result = workspaceAdapter("/root", ctx("monorepo", ["packages/*"]), {
    walk: () => ({
      entries: ["packages/real", "packages/README.md"],
      diagnostics: [],
    }),
    hasPackageJson: (absDir) => absDir.endsWith("real"),
  });
  assert.deepEqual(
    result.partialUnits.map((u) => u.name),
    ["packages/real"],
  );
});

test("workspaceAdapter surfaces UNMATCHED_PATTERN for a glob matching nothing", () => {
  const result = workspaceAdapter(
    "/root",
    ctx("monorepo", ["packages/*", "apps/*"]),
    {
      walk: () => ({ entries: ["packages/a"], diagnostics: [] }),
      hasPackageJson: () => true,
    },
  );
  assert.deepEqual(
    result.partialUnits.map((u) => u.name),
    ["packages/a"],
  );
  const unmatched = result.diagnostics.filter(
    (d) => d.code === "UNMATCHED_PATTERN",
  );
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].path, "apps/*");
});

test("workspaceAdapter drops a candidate escaping root with UNIT_PATH_ESCAPE", () => {
  const result = workspaceAdapter("/root", ctx("monorepo", ["**"]), {
    walk: () => ({ entries: ["../escape", "packages/ok"], diagnostics: [] }),
    hasPackageJson: () => true,
  });
  assert.equal(
    result.partialUnits.some((u) => u.name.includes("..")),
    false,
    "escaping candidate must not become a unit",
  );
  assert.ok(
    result.partialUnits.some((u) => u.name === "packages/ok"),
    "non-escaping candidate is kept",
  );
  const escapes = result.diagnostics.filter(
    (d) => d.code === "UNIT_PATH_ESCAPE",
  );
  assert.equal(escapes.length, 1);
});

test("workspaceAdapter threads walk() truncation diagnostics upward", () => {
  const result = workspaceAdapter("/root", ctx("monorepo", ["packages/*"]), {
    walk: () => ({
      entries: ["packages/a"],
      diagnostics: [
        {
          code: "CENSUS_TRUNCATED",
          severity: "warning",
          path: "packages",
          message: "CENSUS_TRUNCATED: maxEntries exceeded at packages",
        },
      ],
    }),
    hasPackageJson: () => true,
  });
  assert.ok(
    result.diagnostics.some((d) => d.code === "CENSUS_TRUNCATED"),
    "walk truncation diagnostic must be threaded through",
  );
});

test("workspaceAdapter never sorts its own output (serialize.ts is the sole sort site)", () => {
  const src = fs.readFileSync(
    path.join(here, "..", "src", "adapters", "workspace.ts"),
    "utf8",
  );
  const nonComment = src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  assert.equal(nonComment.includes(".sort("), false);
});

test("workspaceAdapter enumerates the real monorepo-pnpm fixture from disk", () => {
  const result = workspaceAdapter(
    monorepoPnpm,
    ctx("monorepo", ["packages/*", "apps/*", "!**/test/**"]),
  );
  const names = result.partialUnits.map((u) => u.name).sort();
  assert.deepEqual(names, [
    "apps/app-a",
    "packages/bad-name",
    "packages/nested-mono",
    "packages/pkg-a",
  ]);
  assert.deepEqual(result.edges, []);
});
