// probeRef — the bounded origin/HEAD default-branch ref probe layered
// over boundedExec. Plain ESM .js importing the already-built dist/ —
// runs unmodified under `node --test` and `bun test`.
//
// The deliberate Dark Factory divergence under test: EVERY failure mode (timeout, ENOENT,
// detached HEAD, no remote, empty stdout) resolves to `null`, never the literal
// string "origin/HEAD" (Unit.ref is string | null). Cases needing a real .git
// materialize a temp git repo; the git-absent/ENOENT path is exercised against a
// nonexistent cwd (boundedExec's error handler). Git-dependent assertions are
// skipped when the git binary is unavailable (some future CI image), mirroring
// exec.test.js's degrade-gracefully posture.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { probeRef } from "../dist/internal/ref-probe.mjs";

function gitAvailable() {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
const GIT = gitAvailable();
const skipNoGit = GIT ? false : "git binary unavailable";

function mkTempRepo(headTarget) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-refprobe-"));
  spawnSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  if (headTarget) {
    spawnSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", headTarget], {
      cwd: dir,
      stdio: "ignore",
    });
  }
  return dir;
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("probeRef strips the origin/ prefix from origin/HEAD -> the bare branch name", {
  skip: skipNoGit,
}, async () => {
  const dir = mkTempRepo("refs/remotes/origin/main");
  try {
    assert.equal(await probeRef(dir), "main");
  } finally {
    rm(dir);
  }
});

test("probeRef returns null (never 'origin/HEAD') when origin/HEAD is unset (no remote / detached)", {
  skip: skipNoGit,
}, async () => {
  const dir = mkTempRepo(null);
  try {
    const ref = await probeRef(dir);
    assert.equal(ref, null);
    assert.notEqual(ref, "origin/HEAD");
  } finally {
    rm(dir);
  }
});

test("probeRef returns null when the repo dir does not exist (spawn ENOENT) and never throws", async () => {
  const missing = path.join(
    os.tmpdir(),
    "platform-map-refprobe-does-not-exist-zzz",
  );
  await assert.doesNotReject(async () => {
    const ref = await probeRef(missing);
    assert.equal(ref, null);
  });
});

test("probeRef is bounded and never hangs — resolves promptly to string|null", async () => {
  const dir = mkTempRepo(GIT ? "refs/remotes/origin/trunk" : null);
  try {
    const start = Date.now();
    const ref = await probeRef(dir, 2000);
    assert.ok(
      Date.now() - start < 5000,
      "probeRef must resolve within its bounded window",
    );
    assert.ok(ref === null || typeof ref === "string");
    if (GIT) assert.equal(ref, "trunk");
  } finally {
    rm(dir);
  }
});
