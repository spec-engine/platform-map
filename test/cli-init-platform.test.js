// D-07 / RED-97 (black-box): `init` platform bootstrap — spawn the BUILT
// dist/platform-map.mjs as a real subprocess against tmpdir trees and assert
// the platform-init plan (definition + per-member markers), the confirm gates,
// per-file refuse-if-exists, and the map() round-trip. Plain ESM .js over
// dist/ (D-06); runs under `node --test` and `bun test` (D-05).
//
// Typed-N decline is gated by parseYesNo behind a real TTY prompt — spawnSync
// gives the child no controlling TTY, so that branch is unreachable black-box
// here; parseYesNo itself is proven white-box in cli-render.test.js and the
// non-TTY refusal (the reachable gate) is asserted below.
//
// The round-trip case sets env HOME on the spawned CLI to the tmp PARENT:
// map() has no CLI boundary flag, and os.homedir() honors HOME on POSIX, so
// the boundary contains the fixture (IP-4).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPlatformInit } from "../dist/internal/cli-render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "dist", "platform-map.mjs");

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    input: opts.input,
    env: opts.env ?? process.env,
  });
}

/** tmpParent/myplat with .git child repos — the canonical platform fixture. */
function seedPlatform(members = ["svc-a", "web"]) {
  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), "pm-init-plat-"));
  const root = path.join(tmpParent, "myplat");
  fs.mkdirSync(root);
  for (const m of members) {
    fs.mkdirSync(path.join(root, m, ".git"), { recursive: true });
  }
  return { tmpParent, root };
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── buildPlatformInit (pure plan builder — zero I/O) ─────────────────────────

test("buildPlatformInit: definition first, one marker per member, member path omitted when equal to name", () => {
  const children = [
    {
      name: "svc-a",
      path: "svc-a",
      ref: null,
      hasDfPointer: false,
      conflict: null,
    },
    {
      name: "web",
      path: "apps/web",
      ref: null,
      hasDfPointer: false,
      conflict: null,
    },
  ];
  const plan = buildPlatformInit("myplat", children);
  assert.equal(plan.length, 3, "definition + one marker per member");
  // Definition leads the plan (root-relative POSIX path).
  assert.equal(plan[0].path, "platform-map.json");
  assert.deepEqual(plan[0].content, {
    name: "myplat",
    members: [{ name: "svc-a" }, { name: "web", path: "apps/web" }],
  });
  assert.equal(
    plan[0].content.members[0].path,
    undefined,
    "path omitted when it equals the member name (IP-1 child-dir convention)",
  );
  // Markers: platform name + explicit root ".." (D-03), keyed by member path.
  assert.deepEqual(plan[1], {
    path: "svc-a/platform-map.json",
    content: { platform: "myplat", root: ".." },
  });
  assert.deepEqual(plan[2], {
    path: "apps/web/platform-map.json",
    content: { platform: "myplat", root: ".." },
  });
  // Deterministic: same inputs, same plan.
  assert.deepEqual(buildPlatformInit("myplat", children), plan);
});

// ── Platform proposal + non-TTY gate (nothing written) ───────────────────────

test("init (non-TTY, no --yes) at a manifest-less dir with .git children: plan JSON on stdout keyed by file path, listing on stderr, exit 1, nothing written", () => {
  const { tmpParent, root } = seedPlatform();
  try {
    const r = run(["init", root]);
    assert.equal(r.status, 1, "non-TTY without --yes → exit 1");
    assert.match(r.stderr, /--yes/, "tells the user to pass --yes");
    // stdout: ONE JSON object keyed by root-relative file path.
    const plan = JSON.parse(r.stdout);
    assert.deepEqual(
      Object.keys(plan),
      ["platform-map.json", "svc-a/platform-map.json", "web/platform-map.json"],
      "definition first, then one marker per member (sorted by name)",
    );
    assert.deepEqual(plan["platform-map.json"], {
      name: "myplat",
      members: [{ name: "svc-a" }, { name: "web" }],
    });
    assert.equal(
      plan["platform-map.json"].members[0].path,
      undefined,
      "conventional members carry no path key",
    );
    assert.deepEqual(plan["svc-a/platform-map.json"], {
      platform: "myplat",
      root: "..",
    });
    assert.deepEqual(plan["web/platform-map.json"], {
      platform: "myplat",
      root: "..",
    });
    // stderr lists EVERY file path in the plan (the confirmation listing).
    for (const p of Object.keys(plan)) {
      assert.ok(r.stderr.includes(p), `stderr lists ${p}`);
    }
    // Refused gate → filesystem untouched.
    assert.equal(fs.existsSync(path.join(root, "platform-map.json")), false);
    assert.equal(
      fs.existsSync(path.join(root, "svc-a", "platform-map.json")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(root, "web", "platform-map.json")),
      false,
    );
  } finally {
    rmrf(tmpParent);
  }
});

// ── --yes writes every listed file, exact bytes ──────────────────────────────

test("init --yes at a platform dir: writes definition + all markers (two-space JSON + trailing newline), exit 0", () => {
  const { tmpParent, root } = seedPlatform();
  try {
    const r = run(["init", "--yes", root]);
    assert.equal(r.status, 0, `expected exit 0, stderr: ${r.stderr}`);
    const expectDefinition = `${JSON.stringify(
      { name: "myplat", members: [{ name: "svc-a" }, { name: "web" }] },
      null,
      2,
    )}\n`;
    const expectMarker = `${JSON.stringify(
      { platform: "myplat", root: ".." },
      null,
      2,
    )}\n`;
    assert.equal(
      fs.readFileSync(path.join(root, "platform-map.json"), "utf8"),
      expectDefinition,
      "root definition written byte-exact",
    );
    for (const m of ["svc-a", "web"]) {
      assert.equal(
        fs.readFileSync(path.join(root, m, "platform-map.json"), "utf8"),
        expectMarker,
        `${m} marker written byte-exact`,
      );
    }
  } finally {
    rmrf(tmpParent);
  }
});

// ── Round-trip: bootstrap then map() shows the members ───────────────────────

test("after init --yes, `--json` at the root (HOME=tmp parent) yields the platform map with all members", () => {
  const { tmpParent, root } = seedPlatform();
  try {
    const init = run(["init", "--yes", root]);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    // HOME → tmp parent so os.homedir()-bounded resolution contains the tree.
    const r = run(["--json", root], {
      env: { ...process.env, HOME: tmpParent },
    });
    assert.equal(r.status, 0, `expected exit 0, stderr: ${r.stderr}`);
    const pm = JSON.parse(r.stdout);
    assert.equal(pm.mode, "multi-repo", "definition at root forces rung 3");
    assert.equal(pm.name, "myplat", "platform name from the definition");
    const names = pm.units.map((u) => u.name);
    assert.ok(names.includes("svc-a"), "member svc-a present");
    assert.ok(names.includes("web"), "member web present");
    // A fresh bootstrap is a HEALTHY platform: no drift diagnostics.
    assert.equal(
      pm.diagnostics.some((d) => d.code === "PLATFORM_DRIFT"),
      false,
      `no drift on a fresh bootstrap: ${JSON.stringify(pm.diagnostics)}`,
    );
  } finally {
    rmrf(tmpParent);
  }
});

// ── D-07 gate: root file exists → whole init refuses ─────────────────────────

test("root platform-map.json exists: whole init refuses (exit 1), no marker written, root file unchanged", () => {
  const { tmpParent, root } = seedPlatform();
  try {
    const before = `${JSON.stringify({ name: "authored" }, null, 2)}\n`;
    fs.writeFileSync(path.join(root, "platform-map.json"), before);
    const r = run(["init", "--yes", root]);
    assert.equal(r.status, 1, "refuse-existing → exit 1");
    assert.match(r.stderr, /already exists|refus/);
    assert.equal(
      fs.readFileSync(path.join(root, "platform-map.json"), "utf8"),
      before,
      "authored root file byte-unchanged",
    );
    assert.equal(
      fs.existsSync(path.join(root, "svc-a", "platform-map.json")),
      false,
      "whole-init refusal writes NO member marker",
    );
    assert.equal(
      fs.existsSync(path.join(root, "web", "platform-map.json")),
      false,
    );
  } finally {
    rmrf(tmpParent);
  }
});

// ── D-07 gate: member file exists → skip that file, write the rest ───────────

test("a member's platform-map.json exists: excluded from the plan with a stderr note, remaining files still written, existing file unchanged", () => {
  const { tmpParent, root } = seedPlatform();
  try {
    const authored = `${JSON.stringify({ name: "custom-svc" }, null, 2)}\n`;
    fs.writeFileSync(path.join(root, "svc-a", "platform-map.json"), authored);
    const r = run(["init", "--yes", root]);
    assert.equal(r.status, 0, `expected exit 0, stderr: ${r.stderr}`);
    assert.match(
      r.stderr,
      /svc-a\/platform-map\.json exists; skipping/,
      "per-member skip note on stderr",
    );
    const plan = JSON.parse(r.stdout);
    assert.equal(
      Object.hasOwn(plan, "svc-a/platform-map.json"),
      false,
      "existing member file excluded from the printed plan",
    );
    // Membership is identity, not the marker file: svc-a STAYS a member.
    assert.deepEqual(plan["platform-map.json"].members, [
      { name: "svc-a" },
      { name: "web" },
    ]);
    assert.equal(
      fs.readFileSync(path.join(root, "svc-a", "platform-map.json"), "utf8"),
      authored,
      "pre-existing member file byte-unchanged",
    );
    assert.ok(
      fs.existsSync(path.join(root, "platform-map.json")),
      "root definition still written",
    );
    assert.ok(
      fs.existsSync(path.join(root, "web", "platform-map.json")),
      "other member's marker still written",
    );
  } finally {
    rmrf(tmpParent);
  }
});

// ── Precedence: a workspace manifest wins over .git children (unchanged) ─────

test("init --yes at a dir with a workspace manifest: today's { name } proposal, no members, no markers", () => {
  const { tmpParent, root } = seedPlatform();
  try {
    fs.writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    const r = run(["init", "--yes", root]);
    assert.equal(r.status, 0, `expected exit 0, stderr: ${r.stderr}`);
    const written = JSON.parse(
      fs.readFileSync(path.join(root, "platform-map.json"), "utf8"),
    );
    assert.deepEqual(
      written,
      { name: "myplat" },
      "monorepo proposal unchanged",
    );
    assert.equal(
      fs.existsSync(path.join(root, "svc-a", "platform-map.json")),
      false,
      "manifest branch writes no member markers",
    );
  } finally {
    rmrf(tmpParent);
  }
});

// ── Back-compat: manifest-less, .git-child-less dir keeps the parent-sibling flow ──

test("init --yes at a childless repo with parent .git siblings: today's { name, units } proposal, no members key", () => {
  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), "pm-init-sib-"));
  try {
    const app = path.join(tmpParent, "app");
    fs.mkdirSync(path.join(app, ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmpParent, "lib", ".git"), { recursive: true });
    const r = run(["init", "--yes", app]);
    assert.equal(r.status, 0, `expected exit 0, stderr: ${r.stderr}`);
    const written = JSON.parse(
      fs.readFileSync(path.join(app, "platform-map.json"), "utf8"),
    );
    assert.equal(written.name, "app");
    assert.equal(written.members, undefined, "no platform definition here");
    assert.ok(
      written.units.some((u) => u.name === "lib"),
      "parent-sibling units proposal unchanged",
    );
    assert.equal(
      fs.existsSync(path.join(tmpParent, "lib", "platform-map.json")),
      false,
      "no marker dropped into a parent sibling",
    );
  } finally {
    rmrf(tmpParent);
  }
});

// ── WR-05: symlinked member child dirs are never written through ────────────

test("init --yes skips a symlinked member child with a note (never writes through the link)", (t) => {
  const { tmpParent, root } = seedPlatform(["svc-a"]);
  try {
    // an outside repo, symlinked in as a child of the platform root
    const outside = path.join(tmpParent, "outside-repo");
    fs.mkdirSync(path.join(outside, ".git"), { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(root, "linked"), "dir");
    } catch {
      t.skip("symlink creation unavailable on this platform");
      return;
    }
    const r = run(["init", "--yes", root]);
    assert.equal(r.status, 0, `expected exit 0, stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes("linked is a symlink; skipping"),
      `expected a skip note, stderr: ${r.stderr}`,
    );
    // the real member's marker was written; nothing went through the link
    assert.ok(
      fs.existsSync(path.join(root, "svc-a", "platform-map.json")),
      "real member marker written",
    );
    assert.equal(
      fs.existsSync(path.join(outside, "platform-map.json")),
      false,
      "no physical write outside the targeted tree",
    );
  } finally {
    rmrf(tmpParent);
  }
});
