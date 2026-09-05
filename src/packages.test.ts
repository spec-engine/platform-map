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

test("python, rust, and go monorepos list their packages, names, deps, and package manager", () => {
  const uv = describeRepo(path.join(fixtures, "monorepo-uv"), "py");
  assert.equal(uv.ecosystem, "python");
  assert.equal(uv.packageName, "acme-py");
  assert.equal(uv.packageManager, "uv");
  assert.deepEqual(
    uv.packages.map((p) => [p.path, p.ecosystem, p.packageName, p.deps]),
    [
      [
        "packages/api",
        "python",
        "acme-api",
        ["acme-core", "fastapi", "pytest", "ruff"],
      ],
      ["packages/core", "python", "acme_core", ["requests"]],
    ],
  );

  const cargo = describeRepo(path.join(fixtures, "monorepo-cargo"), "rs");
  assert.equal(cargo.ecosystem, "rust");
  assert.equal(cargo.packageName, undefined); // a virtual workspace root
  assert.equal(cargo.packageManager, "cargo");
  assert.deepEqual(
    cargo.packages.map((p) => [p.path, p.packageName, p.deps]),
    [
      ["crates/api", "acme-api", ["acme-core", "insta", "libc", "tokio"]],
      ["crates/core", "acme-core", ["serde"]],
    ],
  );

  const go = describeRepo(path.join(fixtures, "monorepo-go"), "go");
  assert.equal(go.ecosystem, "go");
  assert.equal(go.packageManager, "go");
  assert.deepEqual(
    go.packages.map((p) => [p.path, p.packageName, p.deps]),
    [
      [
        "api",
        "example.com/acme/api",
        ["example.com/acme/core", "github.com/lib/pq"],
      ],
      ["core", "example.com/acme/core", []],
    ],
  );
  for (const facts of [uv, cargo, go]) assert.deepEqual(facts.diagnostics, []);
});

test("two ecosystems in one repo: a workspace decides silently, otherwise table order with an info", () => {
  const dir = tmpDir();
  try {
    write(path.join(dir, "package.json"), { name: "tooling" });
    write(
      path.join(dir, "pyproject.toml"),
      '[project]\nname = "svc"\n[tool.uv.workspace]\nmembers = ["libs/*"]\n',
    );
    write(
      path.join(dir, "libs", "a", "pyproject.toml"),
      '[project]\nname = "a"\n',
    );
    const withWorkspace = describeRepo(dir, "x");
    assert.equal(withWorkspace.ecosystem, "python");
    assert.equal(withWorkspace.packageName, "svc");
    assert.equal(withWorkspace.packageManager, "pip");
    assert.deepEqual(withWorkspace.diagnostics, []);

    write(path.join(dir, "pyproject.toml"), '[project]\nname = "svc"\n');
    const plain = describeRepo(dir, "x");
    assert.equal(plain.ecosystem, "node");
    assert.equal(plain.packageName, "tooling");
    assert.deepEqual(
      plain.diagnostics.map((d) => [d.severity, d.code, d.subject]),
      [["info", "AMBIGUOUS_ECOSYSTEM", "x"]],
    );

    write(
      path.join(dir, "Cargo.toml"),
      "[package]\nname = 'x'\nversion = 1979-05-27\n",
    );
    const broken = describeRepo(path.join(dir), "x");
    assert.equal(broken.ecosystem, "node"); // node still first; rust only noted as ambiguous
    assert.deepEqual(
      broken.diagnostics.map((d) => d.code),
      ["AMBIGUOUS_ECOSYSTEM"],
    );
  } finally {
    rm(dir);
  }
});

test("a manifest that does not parse is a warning naming the file, and a repo with none has no ecosystem", () => {
  const dir = tmpDir();
  try {
    write(path.join(dir, "Cargo.toml"), "[package\n");
    const facts = describeRepo(dir, "x");
    assert.equal(facts.ecosystem, "rust");
    assert.deepEqual(
      facts.diagnostics.map((d) => [d.severity, d.code, d.message]),
      [["warning", "MALFORMED_FILE", 'x/Cargo.toml: line 1: expected "]"']],
    );
    write(path.join(dir, "go.work"), "use (\n");
    rm(path.join(dir, "Cargo.toml"));
    const goWork = describeRepo(dir, "x");
    assert.equal(goWork.mode, "monorepo");
    assert.deepEqual(
      goWork.diagnostics.map((d) => [d.code, d.subject]),
      [["MALFORMED_FILE", "x/go.work"]],
    );
    rm(path.join(dir, "go.work"));
    assert.equal(describeRepo(dir, "x").ecosystem, undefined);
  } finally {
    rm(dir);
  }
});
