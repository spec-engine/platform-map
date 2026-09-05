import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { acmePlatform, readJson, rm, tmpDir, write } from "../test/helpers.ts";
import { applyInit, planInit } from "./init.ts";
import { map } from "./map.ts";

test("planInit on a folder of repos proposes a platform named after the folder", () => {
  const dir = tmpDir();
  try {
    const root = acmePlatform(dir, false);
    const plan = planInit(root);
    assert.equal(plan.platformName, "acme");
    assert.deepEqual(plan.members, []);
    assert.deepEqual(
      plan.candidates.map((c) => [c.name, c.hasGit, c.listed]),
      [
        ["api", true, false],
        ["shared", true, false],
        ["webapp", true, false],
      ],
    );
    assert.deepEqual(plan.writes["platform-map.json"], {
      name: "acme",
      members: ["api", "shared", "webapp"],
    });
    assert.deepEqual(plan.writes["api/platform-map.json"], {
      platform: "acme",
      member: "api",
    });
    assert.deepEqual(plan.skipped, []);
    assert.equal(plan.problem, undefined);
  } finally {
    rm(dir);
  }
});

test("applyInit writes the platform file and one marker per confirmed member", () => {
  const dir = tmpDir();
  try {
    const root = acmePlatform(dir, false);
    const result = applyInit(planInit(root), ["api", "shared"]);
    assert.equal(result.written.length, 3);
    assert.deepEqual(readJson(path.join(root, "platform-map.json")), {
      name: "acme",
      members: ["api", "shared"],
    });
    assert.deepEqual(readJson(path.join(root, "api", "platform-map.json")), {
      platform: "acme",
      member: "api",
    });
    assert.equal(
      fs.existsSync(path.join(root, "webapp", "platform-map.json")),
      false,
    );
    const pm = map(root);
    assert.equal(pm.declared, true);
    assert.deepEqual(
      pm.repos.map((r) => r.name),
      ["api", "shared"],
    );
    assert.deepEqual(
      pm.diagnostics.map((d) => [d.code, d.subject]),
      [["UNLISTED_REPO", "webapp"]],
    );
  } finally {
    rm(dir);
  }
});

test("re-running init only proposes what is not yet listed and never overwrites a marker", () => {
  const dir = tmpDir();
  try {
    const root = acmePlatform(dir);
    write(path.join(root, "api", "platform-map.json"), {
      platform: "acme",
      member: "api",
      note: "hand-edited",
    });
    write(path.join(root, "cli", "package.json"), { name: "@acme/cli" });
    const plan = planInit(root);
    assert.deepEqual(plan.members, ["api", "shared", "webapp"]);
    assert.deepEqual(
      plan.candidates.filter((c) => !c.listed).map((c) => c.name),
      ["cli"],
    );
    assert.deepEqual(Object.keys(plan.writes).sort(), [
      "cli/platform-map.json",
      "platform-map.json",
    ]);
    assert.deepEqual(plan.skipped, [
      "api/platform-map.json",
      "shared/platform-map.json",
      "webapp/platform-map.json",
    ]);

    const result = applyInit(plan, ["cli"]);
    assert.deepEqual(readJson(path.join(root, "platform-map.json")), {
      name: "acme",
      members: ["api", "cli", "shared", "webapp"],
    });
    assert.ok(
      result.skipped.includes(path.join(root, "api", "platform-map.json")),
    );
    assert.deepEqual(readJson(path.join(root, "api", "platform-map.json")), {
      platform: "acme",
      member: "api",
      note: "hand-edited",
    });
  } finally {
    rm(dir);
  }
});

test("a candidate carrying another platform's marker is listed but never proposed", () => {
  const dir = tmpDir();
  try {
    const root = acmePlatform(dir, false);
    write(path.join(root, "webapp", "platform-map.json"), {
      platform: "other",
    });
    const plan = planInit(root);
    assert.equal(
      plan.candidates.find((c) => c.name === "webapp")?.marker,
      "other",
    );
    assert.equal(plan.writes["webapp/platform-map.json"], undefined);
    const result = applyInit(plan, ["api", "webapp"]);
    assert.deepEqual(readJson(path.join(root, "platform-map.json")), {
      name: "acme",
      members: ["api"],
    });
    assert.equal(result.written.length, 2);
  } finally {
    rm(dir);
  }
});

test("init from inside a member plans for the platform directory above it", () => {
  const dir = tmpDir();
  try {
    const root = acmePlatform(dir);
    const plan = planInit(path.join(root, "api"));
    assert.equal(plan.root, root);
    assert.equal(plan.platformName, "acme");
  } finally {
    rm(dir);
  }
});

test("a malformed platform file stops init with a problem, writing nothing", () => {
  const dir = tmpDir();
  try {
    write(path.join(dir, "platform-map.json"), "nope");
    const plan = planInit(dir);
    assert.match(plan.problem ?? "", /platform-map\.json/);
    assert.deepEqual(applyInit(plan, []), { written: [], skipped: [] });
  } finally {
    rm(dir);
  }
});
