import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { acmePlatform, rm, tmpDir, write } from "../test/helpers.ts";
import { check, locate, map } from "./map.ts";
import { render, toJSON } from "./render.ts";

function withPlatform(
  fn: (root: string, opts: { userConfigPath: string }) => void,
): void {
  const dir = tmpDir();
  try {
    fn(acmePlatform(dir), { userConfigPath: path.join(dir, "user.json") });
  } finally {
    rm(dir);
  }
}

test("a declared platform maps its members and their packages", () => {
  withPlatform((root, opts) => {
    const pm = map(root, opts);
    assert.equal(pm.mode, "multi-repo");
    assert.equal(pm.declared, true);
    assert.deepEqual(
      pm.repos.map((r) => [r.name, r.mode, r.packageName, r.marker]),
      [
        ["api", "single-repo", "@acme/api", "ok"],
        ["shared", "monorepo", "@acme/shared", "ok"],
        ["webapp", "single-repo", "@acme/webapp", "ok"],
      ],
    );
    const shared = pm.repos[1];
    assert.equal(shared?.packageManager, "pnpm");
    assert.deepEqual(
      shared?.packages.map((p) => [p.path, p.packageName]),
      [
        ["packages/config", "@acme/config"],
        ["packages/ui", "@acme/ui"],
      ],
    );
    assert.deepEqual(pm.diagnostics, []);
  });
});

test("dependsOn holds only the platform's own package names, across repos", () => {
  withPlatform((root, opts) => {
    const pm = map(root, opts);
    const by = Object.fromEntries(pm.repos.map((r) => [r.name, r]));
    assert.deepEqual(by.api?.dependsOn, ["@acme/config"]); // express is not ours
    assert.deepEqual(by.webapp?.dependsOn, ["@acme/config", "@acme/ui"]);
    assert.deepEqual(by.shared?.packages[1]?.dependsOn, ["@acme/config"]);
  });
});

test("the same JSON comes out from the root, a member, and a nested subdirectory", () => {
  withPlatform((root, opts) => {
    write(path.join(root, "api", "src", "deep", "file.ts"), "");
    const fromRoot = toJSON(map(root, opts));
    assert.equal(toJSON(map(path.join(root, "api"), opts)), fromRoot);
    assert.equal(
      toJSON(map(path.join(root, "api", "src", "deep"), opts)),
      fromRoot,
    );
    assert.equal(
      toJSON(map(path.join(root, "shared", "packages", "ui"), opts)),
      fromRoot,
    );
    assert.ok(!fromRoot.includes(root), "no absolute paths in the map");
  });
});

test("a listed member missing from disk is reported and kept as absent", () => {
  withPlatform((root, opts) => {
    rm(path.join(root, "webapp"));
    const pm = map(root, opts);
    const webapp = pm.repos.find((r) => r.name === "webapp");
    assert.equal(webapp?.present, false);
    assert.equal(webapp?.marker, "unknown");
    assert.deepEqual(
      pm.diagnostics.map((d) => [d.code, d.subject]),
      [["MEMBER_MISSING", "webapp"]],
    );
    assert.equal(check(root, opts).ok, false);
  });
});

test("marker problems: missing is a warning, another platform's marker is an error", () => {
  withPlatform((root, opts) => {
    rm(path.join(root, "api", "platform-map.json"));
    write(path.join(root, "webapp", "platform-map.json"), {
      platform: "other",
    });
    const pm = map(root, opts);
    assert.deepEqual(
      pm.diagnostics.map((d) => [d.severity, d.code, d.subject]),
      [
        ["error", "MARKER_MISMATCH", "webapp"],
        ["warning", "MARKER_MISSING", "api"],
      ],
    );
  });
});

test("a repository in the folder that is not a member is reported as info only", () => {
  withPlatform((root, opts) => {
    write(path.join(root, "scratch", "package.json"), { name: "scratch" });
    const pm = map(root, opts);
    assert.equal(pm.repos.length, 3);
    assert.deepEqual(
      pm.diagnostics.map((d) => [d.severity, d.code, d.subject]),
      [["info", "UNLISTED_REPO", "scratch"]],
    );
    assert.equal(check(root, opts).ok, true);
  });
});

test("a folder of repos with no platform file gives a preview map", () => {
  const dir = tmpDir();
  try {
    const root = acmePlatform(dir, false);
    const pm = map(root);
    assert.equal(pm.mode, "multi-repo");
    assert.equal(pm.declared, false);
    assert.equal(pm.name, "acme");
    assert.deepEqual(
      pm.repos.map((r) => [r.name, r.marker]),
      [
        ["api", "missing"],
        ["shared", "missing"],
        ["webapp", "missing"],
      ],
    );
    assert.deepEqual(
      pm.diagnostics.map((d) => d.code),
      ["UNDECLARED_PLATFORM"],
    );
  } finally {
    rm(dir);
  }
});

test("a lone repo and a lone monorepo map to one repo entry", () => {
  const dir = tmpDir();
  try {
    const root = acmePlatform(dir, false);
    const api = map(path.join(root, "api"));
    assert.equal(api.mode, "single-repo");
    assert.equal(api.repos[0]?.marker, "unknown");
    const shared = map(path.join(root, "shared"));
    assert.equal(shared.mode, "monorepo");
    assert.equal(shared.repos.length, 1);
    assert.equal(shared.repos[0]?.packages.length, 2);
  } finally {
    rm(dir);
  }
});

test("a relocated member is found through the user file; locate() reports where", () => {
  const dir = tmpDir();
  try {
    const root = acmePlatform(dir);
    const opts = { userConfigPath: path.join(dir, "user.json") };
    const moved = path.join(dir, "elsewhere", "web");
    write(path.join(dir, "elsewhere", ".keep"), "");
    fs.renameSync(path.join(root, "webapp"), moved);
    write(opts.userConfigPath, { acme: { root, members: { webapp: moved } } });

    const fromMoved = map(moved, opts);
    assert.equal(fromMoved.name, "acme");
    assert.deepEqual(fromMoved.diagnostics, []);
    assert.equal(toJSON(fromMoved), toJSON(map(root, opts)));

    const where = locate(moved, opts);
    assert.equal(where.root, root);
    assert.equal(where.repos.webapp, moved);
    assert.deepEqual(where.overridden, ["webapp"]);
  } finally {
    rm(dir);
  }
});

test("a member whose platform is not on this machine maps alone with a warning", () => {
  const dir = tmpDir();
  try {
    const opts = { userConfigPath: path.join(dir, "user.json") };
    const lonely = path.join(dir, "lonely");
    write(path.join(lonely, "platform-map.json"), { platform: "ghost" });
    write(path.join(lonely, "package.json"), { name: "lonely" });
    const pm = map(lonely, opts);
    assert.equal(pm.mode, "single-repo");
    assert.equal(pm.repos[0]?.marker, "ok");
    assert.deepEqual(
      pm.diagnostics.map((d) => [d.severity, d.code]),
      [["warning", "PLATFORM_NOT_LOCATED"]],
    );
  } finally {
    rm(dir);
  }
});

test("a malformed platform file is an error diagnostic, never a throw", () => {
  const dir = tmpDir();
  try {
    write(path.join(dir, "platform-map.json"), "{ not json");
    const pm = map(dir);
    assert.equal(pm.diagnostics[0]?.code, "MALFORMED_FILE");
    assert.equal(pm.diagnostics[0]?.severity, "error");
    assert.equal(check(dir).ok, false);
  } finally {
    rm(dir);
  }
});

test("a nonexistent directory throws DirectoryNotFoundError", () => {
  assert.throws(() => map("/nonexistent/platform-map-test"), {
    name: "DirectoryNotFoundError",
  });
});

test("a mixed platform: node, python, rust, and go members, each declared and mapped; dependsOn stays within an ecosystem", () => {
  const dir = tmpDir();
  try {
    const fixtures = path.join(import.meta.dirname, "..", "test", "fixtures");
    const root = path.join(dir, "poly");
    const members: Record<string, string | null> = {
      web: null,
      py: "monorepo-uv",
      rs: "monorepo-cargo",
      go: "monorepo-go",
    };
    for (const [name, fixture] of Object.entries(members)) {
      const memberDir = path.join(root, name);
      if (fixture !== null)
        fs.cpSync(path.join(fixtures, fixture), memberDir, { recursive: true });
      fs.mkdirSync(path.join(memberDir, ".git"), { recursive: true });
      write(path.join(memberDir, "platform-map.json"), {
        platform: "poly",
        member: name,
      });
    }
    // "acme-core" exists as a python and a rust package; node must not link to either.
    write(path.join(root, "web", "package.json"), {
      name: "web",
      dependencies: { "acme-core": "*" },
    });
    write(path.join(root, "platform-map.json"), {
      name: "poly",
      members: Object.keys(members),
    });

    const pm = map(root);
    assert.deepEqual(pm.diagnostics, []);
    assert.deepEqual(
      pm.repos.map((r) => [
        r.name,
        r.ecosystem,
        r.mode,
        r.packageManager,
        r.dependsOn,
      ]),
      [
        ["go", "go", "monorepo", "go", []],
        ["py", "python", "monorepo", "uv", []],
        ["rs", "rust", "monorepo", "cargo", []],
        ["web", "node", "single-repo", undefined, []],
      ],
    );
    const by = Object.fromEntries(pm.repos.map((r) => [r.name, r]));
    assert.deepEqual(
      by.go?.packages.map((p) => [p.path, p.ecosystem, p.dependsOn]),
      [
        ["api", "go", ["example.com/acme/core"]],
        ["core", "go", []],
      ],
    );
    // the python dependency is written "acme-core"; the target is declared "acme_core"
    assert.deepEqual(
      by.py?.packages.map((p) => [p.path, p.packageName, p.dependsOn]),
      [
        ["packages/api", "acme-api", ["acme_core"]],
        ["packages/core", "acme_core", []],
      ],
    );
    assert.deepEqual(
      by.rs?.packages.map((p) => [p.path, p.dependsOn]),
      [
        ["crates/api", ["acme-core"]],
        ["crates/core", []],
      ],
    );
    assert.equal(
      toJSON(map(path.join(root, "rs", "crates", "api"))),
      toJSON(pm),
    );
    assert.equal(
      render(pm),
      [
        "poly (multi-repo)",
        "├── go    monorepo     go",
        "│   ├── api   example.com/acme/api",
        "│   └── core  example.com/acme/core",
        "├── py    monorepo     python  acme-py",
        "│   ├── packages/api   acme-api",
        "│   └── packages/core  acme_core",
        "├── rs    monorepo     rust",
        "│   ├── crates/api   acme-api",
        "│   └── crates/core  acme-core",
        "└── web   single-repo  node    web",
        "",
      ].join("\n"),
    );
  } finally {
    rm(dir);
  }
});
