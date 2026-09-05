import assert from "node:assert/strict";
import { test } from "node:test";
import { acmePlatform, rm, tmpDir } from "../test/helpers.ts";
import { map } from "./map.ts";
import { formatDiagnostics, render, toJSON, toMermaid } from "./render.ts";

test("the tree shows repos, packages, and problems in a stable layout", () => {
  const dir = tmpDir();
  try {
    const root = acmePlatform(dir);
    rm(`${root}/webapp/platform-map.json`);
    const pm = map(root);
    assert.equal(
      render(pm),
      [
        "acme (multi-repo)",
        "├── api     single-repo  @acme/api",
        "├── shared  monorepo     @acme/shared",
        "│   ├── packages/config  @acme/config",
        "│   └── packages/ui      @acme/ui",
        "└── webapp  single-repo  @acme/webapp  (no marker)",
        "",
      ].join("\n"),
    );
    assert.match(
      formatDiagnostics(pm),
      /^warning {2}MARKER_MISSING {2}member "webapp"/,
    );
  } finally {
    rm(dir);
  }
});

test("the Mermaid flowchart has one node per repo and package and one arrow per dependsOn", () => {
  const dir = tmpDir();
  try {
    const pm = map(acmePlatform(dir));
    assert.equal(
      toMermaid(pm),
      [
        "flowchart LR",
        '  n_api["api (@acme/api)"]',
        '  subgraph n_shared["shared (monorepo)"]',
        '    n_shared_packages_config["@acme/config"]',
        '    n_shared_packages_ui["@acme/ui"]',
        "  end",
        '  n_webapp["webapp (@acme/webapp)"]',
        "  n_api --> n_shared_packages_config",
        "  n_shared_packages_ui --> n_shared_packages_config",
        "  n_webapp --> n_shared_packages_config",
        "  n_webapp --> n_shared_packages_ui",
        "",
      ].join("\n"),
    );
  } finally {
    rm(dir);
  }
});

test("toJSON is two-space indented with a trailing newline and fixed key order", () => {
  const dir = tmpDir();
  try {
    const text = toJSON(map(acmePlatform(dir)));
    assert.ok(text.endsWith("}\n"));
    const keys = Object.keys(JSON.parse(text));
    assert.deepEqual(keys, [
      "name",
      "mode",
      "declared",
      "repos",
      "diagnostics",
      "schemaVersion",
    ]);
    const repoKeys = Object.keys(JSON.parse(text).repos[0]);
    assert.deepEqual(repoKeys, [
      "name",
      "mode",
      "packageName",
      "dependsOn",
      "packages",
      "present",
      "marker",
    ]);
  } finally {
    rm(dir);
  }
});
