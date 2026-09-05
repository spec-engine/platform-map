// PMAP-014 e2e: spec-engine platform discovery mode. map(platformDir) on a
// directory carrying a canonical `spec-engine/` dir — and no platform-map.json
// — classifies the platform's CHILDREN with Spec Engine's classifySibling
// per-child classification: config-carrying child -> member unit (expanded via
// its members glob), unconfigured repo-root child (.git dir-or-file OR
// package.json) -> UNCONFIGURED_SIBLING, plain folder ->
// silent. A platform-map.json definition always wins over the convention.
//
// Plain ESM .js importing the already-built dist/ — runs unmodified
// under `node --test`. NEVER src/, NEVER .ts. Boundary = the mkdtemp
// parent (tmpdir fixtures live outside os.homedir(), so the boundary
// must be injected for the resolution path to be inert-but-exercised).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { map } from "../dist/index.mjs";
import { toJSON } from "../dist/internal/serialize.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function mktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-sep-"));
}

function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
}

function gitDir(dir) {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
}

function writeMember(dir, config) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "spec-engine.member.json"),
    typeof config === "string" ? config : JSON.stringify(config),
  );
}

/** The PMAP-014 fixture: Spec Engine's fixtures/platform-fixture shape (bare
 *  config-carrying members), plus one expanding member, one config+.git
 *  member, both unconfigured repo-root shapes, and a plain folder. */
function buildSePlatform(parent) {
  const plat = path.join(parent, "plat");
  writeJson(path.join(plat, "spec-engine", "AUTH", "SPEC.json"), {
    domain: "AUTH",
    spec_version: 2,
    requirements: [],
  });

  // Spec Engine fixture shape: members by config presence alone — no .git, no
  // package.json (config confirms membership).
  writeMember(path.join(plat, "admin"), { specs: "spec-engine@2" });
  writeMember(path.join(plat, "api"), { specs: "spec-engine@2" });
  writeMember(path.join(plat, "mobile"), { specs: "spec-engine@1" });

  // Expanding member: the ignore array must NOT filter expansion.
  writeMember(path.join(plat, "expandable"), {
    specs: "spec-engine@2",
    members: "packages/*",
    ignore: ["packages/cli"],
  });
  fs.mkdirSync(path.join(plat, "expandable", "packages", "engine"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(plat, "expandable", "packages", "cli"), {
    recursive: true,
  });

  // Config + .git: a confirmed member that IS a repo (kind:"repo"), never a
  // sibling candidate (no CONFIG_CONFLICT, no UNCONFIGURED_SIBLING).
  writeMember(path.join(plat, "confgit"), { specs: "spec-engine@2" });
  gitDir(path.join(plat, "confgit"));

  gitDir(path.join(plat, "rogue-git")); // unconfigured .git child
  fs.mkdirSync(path.join(plat, "rogue-pkg"));
  writeJson(path.join(plat, "rogue-pkg", "package.json"), {
    name: "rogue-pkg",
  }); // unconfigured package.json-only child (the widened signal)

  fs.mkdirSync(path.join(plat, "docs")); // plain folder -> silent (bucket 3)
  fs.mkdirSync(path.join(plat, ".cache")); // dotdir -> invisible
  return plat;
}

test("spec-engine platform mode classifies children with the per-child classification (PMAP-014)", async () => {
  const parent = mktree();
  try {
    const plat = buildSePlatform(parent);
    const pm = await map(plat, { boundary: parent });

    assert.equal(pm.mode, "multi-repo");
    assert.equal(pm.name, "plat"); // basename — Spec Engine has no platform-name concept

    assert.deepEqual(
      pm.units.map((u) => u.name),
      [
        "admin",
        "api",
        "confgit",
        "expandable",
        "expandable/packages/cli",
        "expandable/packages/engine",
        "mobile",
      ],
    );
    for (const u of pm.units) {
      assert.equal(u.signals.hasSpecEngineConfig, true, u.name);
      assert.ok(u.sources.includes("spec-engine"), u.name);
    }
    // packages/cli is a unit DESPITE the parent config's ignore glob.
    assert.ok(pm.units.some((u) => u.path === "expandable/packages/cli"));

    // Kind rule: bare config members are workspace-packages (never
    // git-probed); a config+.git member is a genuine repo.
    assert.equal(
      pm.units.find((u) => u.name === "admin").kind,
      "workspace-package",
    );
    assert.equal(pm.units.find((u) => u.name === "confgit").kind, "repo");

    // both unconfigured repo-root shapes -> UNCONFIGURED_SIBLING (Spec Engine's
    // unconfigured-sibling case), and neither becomes a unit.
    const unconfigured = pm.diagnostics
      .filter((d) => d.code === "UNCONFIGURED_SIBLING")
      .map((d) => d.path);
    assert.deepEqual(unconfigured, ["rogue-git", "rogue-pkg"]);
    assert.ok(pm.units.every((u) => u.name !== "rogue-git"));
    assert.ok(pm.units.every((u) => u.name !== "rogue-pkg"));

    // Bucket 3 is SILENT: no PLATFORM_DRIFT for plain folders, nothing about
    // docs or the canonical spec-engine dir anywhere in units/diagnostics.
    assert.ok(!pm.diagnostics.some((d) => d.code === "PLATFORM_DRIFT"));
    const rest = JSON.stringify({
      units: pm.units,
      diagnostics: pm.diagnostics,
    });
    assert.ok(!rest.includes("docs"));
    assert.ok(!rest.includes("spec-engine/"));
    assert.ok(pm.units.every((u) => u.name !== "spec-engine"));

    // No absolute path may appear outside pm.root; determinism double-run.
    const { root: _root, ...noRoot } = pm;
    assert.ok(!JSON.stringify(noRoot).includes(parent));
    const again = await map(plat, { boundary: parent });
    assert.equal(toJSON(pm), toJSON(again));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// an Spec Engine member that is ALSO a pnpm monorepo. The flat Spec Engine
// sub-members own the identities; the nested workspace expansion agrees on
// both identity and location, so it is deduped silently, never doubled.
test("an Spec Engine member that is also a workspace monorepo maps to one unit per package", async () => {
  const plat = path.join(here, "fixtures", "se-monorepo-overlap");
  const pm = await map(plat, {
    adapters: { siblings: false },
    refProbe: false,
  });

  assert.deepEqual(
    pm.units.map((u) => u.name),
    ["svc", "svc/packages/x", "svc/packages/y"],
  );
  const svc = pm.units.find((u) => u.name === "svc");
  assert.equal(svc.mode, "monorepo");
  assert.equal(svc.units.length, 0);

  assert.deepEqual(pm.edges, [
    {
      from: "svc/packages/y",
      to: "svc/packages/x",
      via: "workspace-dependency",
    },
  ]);
  const x = pm.units.find((u) => u.name === "svc/packages/x");
  const y = pm.units.find((u) => u.name === "svc/packages/y");
  assert.equal(x.signals.workspaceInDegree, 1);
  assert.equal(y.signals.workspaceOutDegree, 1);

  // Two sources agreeing on the same identity at the same location is
  // agreement, not conflict.
  assert.ok(!pm.diagnostics.some((d) => d.code === "CONFIG_CONFLICT"));

  const names = [];
  (function collect(units) {
    for (const u of units) {
      names.push(u.name);
      if (u.units.length > 0) collect(u.units);
    }
  })(pm.units);
  assert.equal(new Set(names).size, names.length);
});

test("a platform-map.json definition wins over the spec-engine/ convention (PMAP-014 precedence)", async () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    writeJson(path.join(plat, "spec-engine", "AUTH", "SPEC.json"), {
      domain: "AUTH",
      spec_version: 1,
      requirements: [],
    });
    writeJson(path.join(plat, "platform-map.json"), {
      name: "declared",
      members: [{ name: "admin" }],
    });
    writeMember(path.join(plat, "admin"), { specs: "spec-engine@2" });
    writeMember(path.join(plat, "api"), { specs: "spec-engine@2" });

    const pm = await map(plat, { boundary: parent });

    // Definition semantics exactly: declared members only — no per-child Spec Engine
    // classification (api never becomes a unit), definition name wins.
    assert.equal(pm.name, "declared");
    assert.deepEqual(
      pm.units.map((u) => u.name),
      ["admin"],
    );
    assert.ok(pm.units.every((u) => !u.sources.includes("spec-engine")));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a unit-config platform-map.json also suppresses the spec-engine/ convention (PMAP-014 precedence)", async () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    writeJson(path.join(plat, "spec-engine", "AUTH", "SPEC.json"), {
      domain: "AUTH",
      spec_version: 1,
      requirements: [],
    });
    // A unit-level config (no `members`, no `platform` key): platform-map.json
    // of ANY shape is canonical — the spec-engine/ convention must stay inert.
    writeJson(path.join(plat, "platform-map.json"), { name: "custom" });
    writeMember(path.join(plat, "admin"), { specs: "spec-engine@2" });

    const pm = await map(plat, { boundary: parent });

    assert.equal(pm.name, "custom"); // config name, not basename
    assert.ok(pm.units.every((u) => u.name !== "admin"));
    assert.ok(pm.units.every((u) => !u.sources?.includes("spec-engine")));
    assert.notEqual(pm.mode, "multi-repo");
    assert.ok(!pm.diagnostics.some((d) => d.code === "UNCONFIGURED_SIBLING"));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("disabling the spec-engine adapter disables spec-engine platform mode entirely (PMAP-014)", async () => {
  const parent = mktree();
  try {
    const plat = buildSePlatform(parent);
    const pm = await map(plat, {
      boundary: parent,
      adapters: { "spec-engine": false },
    });

    // 0.1.0 behavior: no child classification, no member units, no promotion
    // gate — the spec-engine/ dir is inert.
    assert.ok(pm.units.every((u) => u.name !== "admin"));
    assert.ok(!pm.diagnostics.some((d) => d.code === "UNCONFIGURED_SIBLING"));
    assert.notEqual(pm.mode, "multi-repo");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a malformed child member config degrades to a re-anchored MALFORMED_CONFIG and never gates as a sibling (PMAP-014)", async () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    writeJson(path.join(plat, "spec-engine", "AUTH", "SPEC.json"), {
      domain: "AUTH",
      spec_version: 1,
      requirements: [],
    });
    writeMember(path.join(plat, "admin"), "{ not valid json ");
    gitDir(path.join(plat, "admin")); // even as a repo root: config-carrying

    let pm;
    await assert.doesNotReject(async () => {
      pm = await map(plat, { boundary: parent });
    });
    const malformed = pm.diagnostics.find((d) => d.code === "MALFORMED_CONFIG");
    assert.ok(malformed);
    assert.equal(malformed.path, "admin/spec-engine.member.json");
    // Config PRESENCE confirms membership: never UNCONFIGURED_SIBLING advice
    // to `spec init` a directory that already has a (broken) config.
    assert.ok(!pm.diagnostics.some((d) => d.code === "UNCONFIGURED_SIBLING"));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
