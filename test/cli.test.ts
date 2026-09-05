// End-to-end: the built CLI (dist/platform-map.mjs) against real directories.
// Run `npm run build` first; CI does.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { acmePlatform, readJson, rm, tmpDir, write } from "./helpers.ts";

const cli = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "platform-map.mjs",
);

function run(cwd: string, args: string[], userFile: string) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PLATFORM_MAP_CONFIG: userFile },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("the 30-second path: preview, init --yes, map, check", () => {
  const dir = tmpDir();
  const user = path.join(dir, "user.json");
  try {
    const root = acmePlatform(dir, false);
    write(path.join(root, "scratch", "package.json"), { name: "scratch" });

    const preview = run(root, [], user);
    assert.equal(preview.code, 0);
    assert.match(preview.out, /^acme \(multi-repo, undeclared\)/);
    assert.match(preview.err, /UNDECLARED_PLATFORM/);

    const init = run(root, ["init", "--yes", "--ignore", "scratch"], user);
    assert.equal(init.code, 0);
    assert.equal(
      init.out.split("\n").filter((l) => l.startsWith("wrote ")).length,
      4,
    );
    assert.deepEqual(readJson(path.join(root, "platform-map.json")), {
      name: "acme",
      members: ["api", "shared", "webapp"],
      ignore: ["scratch"],
    });

    const fromMember = run(
      path.join(root, "shared", "packages", "ui"),
      [],
      user,
    );
    assert.equal(fromMember.code, 0);
    assert.match(fromMember.out, /^acme \(multi-repo\)\n/);
    assert.equal(fromMember.err, "");

    const check = run(root, ["check"], user);
    assert.equal(check.code, 0);
    assert.match(check.err, /ok/);

    // the ignore sticks: no UNLISTED_REPO for scratch, and a re-run has nothing to add
    assert.equal(run(root, [], user).err, "");
    assert.match(run(root, ["init", "--yes"], user).err, /Nothing new/);
  } finally {
    rm(dir);
  }
});

test("--json is clean on stdout and identical from root and member; --mermaid and --paths render", () => {
  const dir = tmpDir();
  const user = path.join(dir, "user.json");
  try {
    const root = acmePlatform(dir);
    const a = run(root, ["--json"], user);
    const b = run(path.join(root, "api"), ["--json"], user);
    assert.equal(a.code, 0);
    assert.equal(a.err, "");
    assert.equal(a.out, b.out);
    assert.equal(JSON.parse(a.out).schemaVersion, 2);
    assert.match(run(root, ["--mermaid"], user).out, /^flowchart LR\n/);
    assert.match(
      run(root, ["--paths"], user).out,
      new RegExp(`api {2,}single-repo {2,}@acme/api {2,}${root}/api`),
    );
    assert.ok(
      "paths" in JSON.parse(run(root, ["--json", "--paths"], user).out),
    );
  } finally {
    rm(dir);
  }
});

test("check exits 1 on a missing member; link repairs it; dry-run init writes nothing", () => {
  const dir = tmpDir();
  const user = path.join(dir, "user.json");
  try {
    const root = acmePlatform(dir);
    const moved = path.join(dir, "elsewhere", "web");
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(path.join(root, "webapp"), moved);

    const failing = run(root, ["check"], user);
    assert.equal(failing.code, 1);
    assert.match(failing.err, /MEMBER_MISSING/);

    const link = run(moved, ["link", "--root", root, "--yes"], user);
    assert.equal(link.code, 0);
    assert.deepEqual(readJson(user), {
      acme: { root, members: { webapp: moved } },
    });
    assert.equal(run(root, ["check"], user).code, 0);

    write(path.join(root, "extra", "package.json"), { name: "extra" });
    const dry = run(root, ["init", "--dry-run"], user);
    assert.equal(dry.code, 0);
    assert.ok("extra/platform-map.json" in JSON.parse(dry.out));
    assert.equal(
      fs.existsSync(path.join(root, "extra", "platform-map.json")),
      false,
    );
  } finally {
    rm(dir);
  }
});

test("usage errors and a missing directory exit 1 with one line; --help and --version exit 0", () => {
  const dir = tmpDir();
  const user = path.join(dir, "user.json");
  try {
    assert.equal(run(dir, ["--nope"], user).code, 1);
    const missing = run(dir, ["does-not-exist"], user);
    assert.equal(missing.code, 1);
    assert.equal(
      missing.err,
      "platform-map: directory not found: does-not-exist\n",
    );
    assert.equal(run(dir, ["--help"], user).code, 0);
    assert.match(run(dir, ["--version"], user).out, /^\d+\.\d+\.\d+/);
    const root = acmePlatform(dir, false);
    assert.equal(
      run(root, ["init"], user).code,
      1,
      "no TTY and no --yes refuses to write",
    );
    assert.equal(fs.existsSync(path.join(root, "platform-map.json")), false);
  } finally {
    rm(dir);
  }
});
