// (black-box): the --boundary CLI flag threads to MapOptions.boundary,
// giving containers/CI rung-3 resolution without faking HOME. Spawns the
// BUILT dist/platform-map.mjs against tmpdir trees; plain ESM .js
// under `node --test`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "dist", "platform-map.mjs");

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });
}

function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
}

test("--boundary: map from inside a member resolves to the platform root (no HOME faking)", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pm-cli-boundary-"));
  try {
    const plat = path.join(parent, "plat");
    fs.mkdirSync(path.join(plat, ".git"), { recursive: true });
    writeJson(path.join(plat, "platform-map.json"), {
      name: "acme",
      members: [{ name: "svc" }],
    });
    const svc = path.join(plat, "svc");
    fs.mkdirSync(path.join(svc, ".git"), { recursive: true });
    writeJson(path.join(svc, "platform-map.json"), { platform: "acme" });

    // Without --boundary (and HOME far away) the walk is inert: rung-1/2 map.
    const without = run(["--json", svc]);
    assert.equal(without.status, 0);
    assert.equal(JSON.parse(without.stdout).name, "svc");

    // With --boundary the marker is followed and the platform map comes back.
    const withFlag = run(["--json", "--boundary", parent, svc]);
    assert.equal(withFlag.status, 0, withFlag.stderr);
    const pm = JSON.parse(withFlag.stdout);
    assert.equal(pm.name, "acme");
    assert.equal(pm.root, plat);
    assert.deepEqual(
      pm.units.map((u) => u.name),
      ["svc"],
    );

    // Deterministic across runs with the flag.
    assert.equal(
      run(["--json", "--boundary", parent, svc]).stdout,
      withFlag.stdout,
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("--boundary without a value is a usage error (exit 1)", () => {
  const r = run(["--boundary"]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("missing value for --boundary"));
});

test("--help documents the --boundary flag", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("--boundary <dir>"));
});
