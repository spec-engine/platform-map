import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ECOSYSTEMS, ecosystem, renderEcosystemsTable } from "./ecosystems.ts";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("node: name, the three dependency blocks, and an invalid name dropped", () => {
  const read = ecosystem("node").readManifest(
    JSON.stringify({
      name: "@x/app",
      dependencies: { a: "1" },
      devDependencies: { b: "1" },
      peerDependencies: { c: "1" },
    }),
  );
  assert.deepEqual(read, { packageName: "@x/app", deps: ["a", "b", "c"] });
  assert.equal(
    ecosystem("node").readManifest('{"name":"Not Valid!"}').packageName,
    undefined,
  );
  assert.match(ecosystem("node").readManifest("{").problem ?? "", /JSON/);
});

test("python: [project] name, every dependency list, PEP 508 names, PEP 503 matching", () => {
  const read = ecosystem("python").readManifest(
    [
      "[project]",
      'name = "Acme_Web"',
      'dependencies = ["acme-core[x]>=1; python_version>\'3\'", "requests @ https://x/y.whl", "PyYAML"]',
      "[project.optional-dependencies]",
      'dev = ["pytest>=8"]',
      "[dependency-groups]",
      'lint = ["ruff", { include-group = "dev" }]',
    ].join("\n"),
  );
  assert.deepEqual(read, {
    packageName: "Acme_Web",
    deps: ["PyYAML", "acme-core", "pytest", "requests", "ruff"],
  });
  assert.equal(ecosystem("python").canonical("Acme_Web.X"), "acme-web-x");
  assert.deepEqual(
    ecosystem("python").readManifest("[tool.ruff]\nline-length = 100\n"),
    {
      deps: [],
    },
  );
  assert.match(
    ecosystem("python").readManifest("[project\n").problem ?? "",
    /line 1/,
  );
});

test("rust: [package] name, the dependency tables including per target, renamed deps", () => {
  const read = ecosystem("rust").readManifest(
    fs.readFileSync(
      path.join(repoRoot, "test/fixtures/monorepo-cargo/crates/api/Cargo.toml"),
      "utf8",
    ),
  );
  assert.deepEqual(read, {
    packageName: "acme-api",
    deps: ["acme-core", "insta", "libc", "tokio"],
  });
  assert.deepEqual(
    ecosystem("rust").readManifest('[workspace]\nmembers = ["a"]\n'),
    { deps: [] },
  );
});

test("go: the module path is the name, require lines are the deps", () => {
  const read = ecosystem("go").readManifest(
    fs.readFileSync(
      path.join(repoRoot, "test/fixtures/monorepo-go/api/go.mod"),
      "utf8",
    ),
  );
  assert.deepEqual(read, {
    packageName: "example.com/acme/api",
    deps: ["example.com/acme/core", "github.com/lib/pq"],
  });
  assert.match(
    ecosystem("go").readManifest("require (\n").problem ?? "",
    /unclosed/,
  );
});

test("every ecosystem has a manifest, at least one workspace kind, and docs", () => {
  assert.deepEqual(
    ECOSYSTEMS.map((e) => e.name),
    ["node", "python", "rust", "go"],
  );
  for (const e of ECOSYSTEMS) {
    assert.ok(e.manifest.length > 0);
    assert.ok(e.workspaces.length > 0);
    assert.ok(e.docs.workspace.length > 0 && e.docs.dependsOn.length > 0);
  }
});

test("the README's Supported ecosystems table is the one the table renders", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const block =
    /<!-- ecosystems:start -->\n([\s\S]*?)\n<!-- ecosystems:end -->/.exec(
      readme,
    );
  assert.ok(block, "README.md has the ecosystems markers");
  assert.equal(
    block[1],
    renderEcosystemsTable(),
    "README.md drifted from src/ecosystems.ts; run `npm run docs:ecosystems`",
  );
});
