import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { acmePlatform, gitRepo, rm, tmpDir, write } from "../test/helpers.ts";
import { findStart, resolvePlatform } from "./resolve.ts";

test("findStart climbs to the nearest platform-map.json or .git, else stays put", () => {
  const dir = tmpDir();
  try {
    const root = acmePlatform(dir);
    write(path.join(root, "api", "src", "a", "b.ts"), "");
    assert.equal(
      findStart(path.join(root, "api", "src", "a")),
      path.join(root, "api"),
    );
    assert.equal(findStart(path.join(root, "api")), path.join(root, "api"));
    assert.equal(findStart(root), root);
    write(path.join(dir, "loose", "x", "y.txt"), "");
    assert.equal(
      findStart(path.join(dir, "loose", "x")),
      path.join(dir, "loose", "x"),
    );
  } finally {
    rm(dir);
  }
});

test("resolvePlatform: platform file here, marker with parent, marker via user file, marker unlocated", () => {
  const dir = tmpDir();
  try {
    const root = acmePlatform(dir);
    const opts = { userConfigPath: path.join(dir, "user.json") };
    assert.equal(resolvePlatform(root, opts).kind, "platform");

    const viaParent = resolvePlatform(path.join(root, "api"), opts);
    assert.equal(viaParent.kind, "platform");
    if (viaParent.kind === "platform") assert.equal(viaParent.root, root);

    const away = path.join(dir, "away");
    gitRepo(away);
    write(path.join(away, "platform-map.json"), {
      platform: "acme",
      member: "away",
    });
    const unlocated = resolvePlatform(away, opts);
    assert.equal(unlocated.kind, "unlocated");
    assert.equal(unlocated.diagnostics[0]?.code, "PLATFORM_NOT_LOCATED");

    write(opts.userConfigPath, { acme: { root } });
    const viaUser = resolvePlatform(away, opts);
    assert.equal(viaUser.kind, "platform");
    if (viaUser.kind === "platform") assert.equal(viaUser.root, root);

    write(opts.userConfigPath, { acme: { root: path.join(dir, "wrong") } });
    assert.equal(resolvePlatform(away, opts).kind, "unlocated");
  } finally {
    rm(dir);
  }
});
