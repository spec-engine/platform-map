import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { acmePlatform, readJson, rm, tmpDir, write } from "../test/helpers.ts";
import { applyLink, planLink } from "./link.ts";
import { map } from "./map.ts";

function relocate(root: string, member: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(path.join(root, member), to);
}

test("linking a relocated member records it under its member name and makes the map whole again", () => {
  const dir = tmpDir();
  try {
    const root = acmePlatform(dir);
    const opts = { userConfigPath: path.join(dir, "user.json") };
    const moved = path.join(dir, "checkouts", "acme-web");
    relocate(root, "webapp", moved);
    assert.equal(map(root, opts).diagnostics[0]?.code, "MEMBER_MISSING");

    const plan = planLink(moved, { ...opts, root });
    assert.equal(plan.platformName, "acme");
    assert.equal(plan.root, root);
    assert.deepEqual(plan.members, { webapp: moved });
    assert.equal(plan.problem, undefined);

    const result = applyLink(plan, opts);
    assert.deepEqual(result.written, [opts.userConfigPath]);
    assert.deepEqual(readJson(opts.userConfigPath), {
      acme: { root, members: { webapp: moved } },
    });
    assert.deepEqual(map(root, opts).diagnostics, []);
    assert.deepEqual(map(moved, opts).diagnostics, []);
  } finally {
    rm(dir);
  }
});

test("link without --root uses the user file when the platform is already known", () => {
  const dir = tmpDir();
  try {
    const root = acmePlatform(dir);
    const opts = { userConfigPath: path.join(dir, "user.json") };
    write(opts.userConfigPath, { acme: { root } });
    const moved = path.join(dir, "elsewhere", "api");
    relocate(root, "api", moved);
    const plan = planLink(moved, opts);
    assert.equal(plan.root, root);
    assert.deepEqual(plan.members, { api: moved });
  } finally {
    rm(dir);
  }
});

test("link in a conventional checkout records only the root", () => {
  const dir = tmpDir();
  try {
    const root = acmePlatform(dir);
    const opts = { userConfigPath: path.join(dir, "user.json") };
    const plan = planLink(path.join(root, "api"), opts);
    assert.equal(plan.root, root);
    assert.deepEqual(plan.members, {});
    applyLink(plan, opts);
    assert.deepEqual(readJson(opts.userConfigPath), { acme: { root } });
  } finally {
    rm(dir);
  }
});

test("link reports a problem when the platform cannot be located or --root is wrong", () => {
  const dir = tmpDir();
  try {
    const opts = { userConfigPath: path.join(dir, "user.json") };
    const lonely = path.join(dir, "lonely");
    write(path.join(lonely, "platform-map.json"), {
      platform: "ghost",
      member: "lonely",
    });
    assert.match(planLink(lonely, opts).problem ?? "", /--root/);
    assert.match(
      planLink(lonely, { ...opts, root: dir }).problem ?? "",
      /no platform file named "ghost"/,
    );
    const bare = path.join(dir, "bare");
    write(path.join(bare, "package.json"), {});
    assert.match(planLink(bare, opts).problem ?? "", /init/);
  } finally {
    rm(dir);
  }
});

test("applyLink keeps other platforms in the user file untouched", () => {
  const dir = tmpDir();
  try {
    const root = acmePlatform(dir);
    const opts = { userConfigPath: path.join(dir, "user.json") };
    write(opts.userConfigPath, { other: { root: "/x", members: { a: "/y" } } });
    applyLink(planLink(root, opts), opts);
    assert.deepEqual(readJson(opts.userConfigPath), {
      other: { root: "/x", members: { a: "/y" } },
      acme: { root },
    });
  } finally {
    rm(dir);
  }
});
