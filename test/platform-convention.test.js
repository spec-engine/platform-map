// RED-97 Task 2 (PMAP-010/011 e2e): map() rung-3 assembly — the platform-root
// convention. Definition at a small platform root -> member units; run-anywhere
// equivalence (root vs member root vs nested subdir, byte-identical including
// pm.root); local disk-location overrides that never leak into output (IP-6);
// assembly-time drift diagnostics (IP-5/IP-7, D-04); determinism double-runs
// on every new path.
//
// Plain ESM .js importing the already-built dist/ (D-06) — runs unmodified
// under `node --test` (D-05). NEVER src/, NEVER .ts. Boundary = the mkdtemp
// parent (IP-4: tmpdir fixtures live outside os.homedir(), so the boundary
// must be injected for the feature to be testable).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { map } from "../dist/index.mjs";
import { toJSON } from "../dist/internal/serialize.mjs";

function mktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-conv-"));
}

function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
}

function gitDir(dir) {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
}

/** The canonical PMAP-011 fixture: a platform-root repo holding the checked-in
 *  definition, with a plain single-repo member and a pnpm monorepo member
 *  (with an internal edge) mixed together, plus an unlisted .git child, a
 *  non-repo child dir, and an ignored dotdir. */
function buildPlatform(parent) {
  const plat = path.join(parent, "plat");
  gitDir(plat); // the platform root is itself a small git repo (D-01)
  writeJson(path.join(plat, "platform-map.json"), {
    name: "acme",
    members: [{ name: "mono-lib" }, { name: "plain-svc" }],
  });

  const plain = path.join(plat, "plain-svc");
  gitDir(plain);
  writeJson(path.join(plain, "package.json"), {
    name: "plain-svc",
    scripts: { start: "node ." },
  });
  writeJson(path.join(plain, "platform-map.json"), { platform: "acme" });

  const mono = path.join(plat, "mono-lib");
  gitDir(mono);
  fs.writeFileSync(
    path.join(mono, "pnpm-workspace.yaml"),
    "packages:\n  - 'packages/*'\n",
  );
  writeJson(path.join(mono, "platform-map.json"), { platform: "acme" });
  writeJson(path.join(mono, "packages", "core", "package.json"), {
    name: "@mono/core",
    private: true,
    exports: { ".": "./index.js" },
  });
  writeJson(path.join(mono, "packages", "app", "package.json"), {
    name: "@mono/app",
    dependencies: { "@mono/core": "workspace:*" },
    scripts: { start: "node ." },
  });

  gitDir(path.join(plat, "rogue")); // unlisted .git child -> UNCONFIGURED_SIBLING
  fs.mkdirSync(path.join(plat, "notes")); // non-repo child -> PLATFORM_DRIFT info
  fs.mkdirSync(path.join(plat, ".cache")); // dotdir -> ignored entirely
  return plat;
}

/** Everything except pm.root (the documented caller-anchor exception) must be
 *  machine-path-free. */
function assertNoAbsolutePaths(pm, parent) {
  const { root: _root, ...rest } = pm;
  assert.ok(
    !JSON.stringify(rest).includes(parent),
    "no absolute path may appear in units/edges/diagnostics",
  );
}

test("rung 3 at root: definition yields member units for mixed shapes (PMAP-011, D-01/D-04)", async () => {
  const parent = mktree();
  try {
    const plat = buildPlatform(parent);
    const pm = await map(plat, { boundary: parent });

    assert.equal(pm.mode, "multi-repo");
    assert.equal(pm.name, "acme"); // definition name, not basename(root)
    assert.deepEqual(
      pm.units.map((u) => u.name),
      ["mono-lib", "plain-svc"],
    );

    const mono = pm.units.find((u) => u.name === "mono-lib");
    assert.equal(mono.kind, "repo");
    assert.equal(mono.path, "mono-lib"); // conventional path
    assert.equal(mono.mode, "monorepo");
    assert.deepEqual(
      mono.units.map((u) => u.name),
      ["packages/app", "packages/core"],
    );
    // the monorepo member's internal edge is present
    assert.deepEqual(pm.edges, [
      {
        from: "packages/app",
        to: "packages/core",
        via: "workspace-dependency",
      },
    ]);

    const plain = pm.units.find((u) => u.name === "plain-svc");
    assert.equal(plain.kind, "repo");
    assert.equal(plain.mode, "single-repo");
    assert.equal(plain.signals.hasStartScript, true);
    assert.equal(plain.role, "app");

    // unlisted .git child -> UNCONFIGURED_SIBLING (D-04: never silent)
    const rogue = pm.diagnostics.find((d) => d.code === "UNCONFIGURED_SIBLING");
    assert.ok(rogue);
    assert.equal(rogue.path, "rogue");
    assert.ok(pm.units.every((u) => u.name !== "rogue"));

    // non-repo child dir -> PLATFORM_DRIFT info (D-04)
    const nonRepo = pm.diagnostics.find(
      (d) => d.code === "PLATFORM_DRIFT" && d.severity === "info",
    );
    assert.ok(nonRepo);
    assert.equal(nonRepo.path, "notes");
    assert.ok(nonRepo.message.startsWith("PLATFORM_DRIFT: non-repo child:"));

    // healthy markers -> no drift warnings; dotdirs invisible
    assert.ok(
      !pm.diagnostics.some(
        (d) => d.code === "PLATFORM_DRIFT" && d.severity === "warning",
      ),
    );
    assert.ok(!JSON.stringify(pm.diagnostics).includes(".cache"));

    assertNoAbsolutePaths(pm, parent);

    // determinism: double-run byte-identity on the rung-3 root path
    assert.equal(
      toJSON(await map(plat, { boundary: parent })),
      toJSON(await map(plat, { boundary: parent })),
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("PMAP-010 equivalence: map() from member roots and nested subdirs is byte-identical to map() at the platform root", async () => {
  const parent = mktree();
  try {
    const plat = buildPlatform(parent);
    const jRoot = toJSON(await map(plat, { boundary: parent }));
    const insides = [
      path.join(plat, "plain-svc"), // single-repo member root
      path.join(plat, "mono-lib"), // monorepo member root
      path.join(plat, "mono-lib", "packages", "core"), // nested member subdir
    ];
    for (const dir of insides) {
      const j = toJSON(await map(dir, { boundary: parent }));
      assert.equal(j, jRoot, `map(${path.basename(dir)}) must equal map(root)`);
      // determinism on every from-inside path
      assert.equal(toJSON(await map(dir, { boundary: parent })), j);
    }
    // pm.root equivalence is included: jRoot embeds the resolved platform root
    assert.ok(jRoot.includes(JSON.stringify(plat).slice(1, -1)));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("PMAP-012 marker drift: wrong platform name -> PLATFORM_DRIFT warning from BOTH at-root and from-inside runs (byte-equal)", async () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    gitDir(plat);
    writeJson(path.join(plat, "platform-map.json"), {
      name: "acme",
      members: [{ name: "m1" }],
    });
    const m1 = path.join(plat, "m1");
    gitDir(m1);
    writeJson(path.join(m1, "platform-map.json"), { platform: "wrong" });

    const jRoot = toJSON(await map(plat, { boundary: parent }));
    const jInside = toJSON(await map(m1, { boundary: parent }));
    assert.equal(jInside, jRoot);

    const pm = JSON.parse(jRoot);
    const drift = pm.diagnostics.find(
      (d) =>
        d.code === "PLATFORM_DRIFT" &&
        d.message.startsWith("PLATFORM_DRIFT: marker platform-name mismatch:"),
    );
    assert.ok(drift);
    assert.equal(drift.severity, "warning");
    assert.ok(drift.message.includes('"wrong"'));
    assert.ok(drift.message.includes('"acme"'));
    assertNoAbsolutePaths(pm, parent);

    assert.equal(toJSON(await map(plat, { boundary: parent })), jRoot);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("PMAP-012 marker drift: root hint that resolves elsewhere -> root-hint-mismatch warning", async () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    gitDir(plat);
    writeJson(path.join(plat, "platform-map.json"), {
      name: "acme",
      members: [{ name: "m1" }],
    });
    const m1 = path.join(plat, "m1");
    gitDir(m1);
    writeJson(path.join(m1, "platform-map.json"), {
      platform: "acme",
      root: "../..",
    });

    const pm = await map(plat, { boundary: parent });
    const drift = pm.diagnostics.find(
      (d) =>
        d.code === "PLATFORM_DRIFT" &&
        d.message.startsWith("PLATFORM_DRIFT: marker root-hint mismatch:"),
    );
    assert.ok(drift);
    assert.equal(drift.severity, "warning");
    assert.ok(drift.message.includes('"../.."'));
    assertNoAbsolutePaths(pm, parent);

    assert.equal(
      toJSON(await map(plat, { boundary: parent })),
      toJSON(await map(plat, { boundary: parent })),
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("PMAP-012 dangling marker: hint target holds no definition -> drift warning + rung-1/2 fallback", async () => {
  const parent = mktree();
  try {
    const member = path.join(parent, "solo-member");
    gitDir(member);
    writeJson(path.join(member, "platform-map.json"), { platform: "ghost" });

    const pm = await map(member, { boundary: parent });
    // fallback: the member maps standalone (rung-1/2 behavior), root untouched
    assert.equal(pm.root, member);
    assert.equal(pm.name, "solo-member");
    const drift = pm.diagnostics.find(
      (d) =>
        d.code === "PLATFORM_DRIFT" &&
        d.message.startsWith("PLATFORM_DRIFT: dangling marker:"),
    );
    assert.ok(drift);
    assert.equal(drift.severity, "warning");
    assertNoAbsolutePaths(pm, parent);

    assert.equal(
      toJSON(await map(member, { boundary: parent })),
      toJSON(await map(member, { boundary: parent })),
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("local override (D-02/IP-6): relocated member is read from the override; output stays conventional and byte-identical", async () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    gitDir(plat);
    writeJson(path.join(plat, "platform-map.json"), {
      name: "acme",
      members: [{ name: "svc" }],
    });
    const svc = path.join(plat, "svc");
    gitDir(svc);
    writeJson(path.join(svc, "package.json"), {
      name: "svc",
      scripts: { start: "node ." },
    });
    writeJson(path.join(svc, "platform-map.json"), { platform: "acme" });

    const jConventional = toJSON(await map(plat, { boundary: parent }));

    // relocate the member on disk and point the per-user local file at it
    fs.renameSync(svc, path.join(parent, "relocated-svc"));
    writeJson(path.join(plat, "platform-map.local.json"), {
      locations: { svc: "../relocated-svc" },
    });

    const jOverride = toJSON(await map(plat, { boundary: parent }));
    // byte-identical with and without the equivalent local override
    assert.equal(jOverride, jConventional);

    const pm = JSON.parse(jOverride);
    const unit = pm.units.find((u) => u.name === "svc");
    assert.equal(unit.path, "svc"); // NEVER the override location
    assert.equal(unit.signals.hasStartScript, true); // read from the override dir
    assert.equal(unit.role, "app");
    assertNoAbsolutePaths(pm, parent);
    assert.ok(!JSON.stringify(pm).includes("relocated-svc"));

    // determinism on the with-local-override path
    assert.equal(toJSON(await map(plat, { boundary: parent })), jOverride);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("local override: unknown member -> dangling-override drift; boundary escape -> UNIT_PATH_ESCAPE + member treated as missing", async () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    gitDir(plat);
    writeJson(path.join(plat, "platform-map.json"), {
      name: "acme",
      members: [{ name: "svc" }],
    });
    const svc = path.join(plat, "svc");
    gitDir(svc);
    writeJson(path.join(svc, "package.json"), {
      name: "svc",
      scripts: { start: "node ." },
    });
    writeJson(path.join(plat, "platform-map.local.json"), {
      locations: { ghost: "somewhere", svc: "../../outside" },
    });

    const pm = await map(plat, { boundary: parent });

    const dangling = pm.diagnostics.find(
      (d) =>
        d.code === "PLATFORM_DRIFT" &&
        d.message.startsWith("PLATFORM_DRIFT: dangling local override:"),
    );
    assert.ok(dangling);
    assert.equal(dangling.severity, "warning");
    assert.ok(dangling.message.includes('"ghost"'));

    const escapeDiag = pm.diagnostics.find(
      (d) =>
        d.code === "UNIT_PATH_ESCAPE" &&
        d.message.includes("escapes resolution boundary"),
    );
    assert.ok(escapeDiag);
    assert.ok(escapeDiag.message.includes('"svc"'));
    assert.ok(!escapeDiag.message.includes(parent)); // never a machine path

    // the escaped member is treated as missing: unit still emitted, empty
    // signals (the conventional dir is NOT read), plus listed-member drift
    const unit = pm.units.find((u) => u.name === "svc");
    assert.ok(unit);
    assert.equal(unit.signals.hasStartScript, undefined);
    assert.equal(unit.ref, null);
    const missing = pm.diagnostics.find(
      (d) =>
        d.code === "PLATFORM_DRIFT" &&
        d.message.startsWith("PLATFORM_DRIFT: listed member missing:"),
    );
    assert.ok(missing);
    assertNoAbsolutePaths(pm, parent);

    assert.equal(
      toJSON(await map(plat, { boundary: parent })),
      toJSON(await map(plat, { boundary: parent })),
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("WR-02: a symlinked local-override target physically outside the boundary -> escape, never read", async (t) => {
  const parent = mktree();
  const outsideTree = mktree(); // a SIBLING tmpdir — physically outside `parent`
  try {
    const plat = path.join(parent, "plat");
    gitDir(plat);
    writeJson(path.join(plat, "platform-map.json"), {
      name: "acme",
      members: [{ name: "svc" }],
    });
    // the member's real content lives physically outside the boundary
    const outsideSvc = path.join(outsideTree, "svc");
    gitDir(outsideSvc);
    writeJson(path.join(outsideSvc, "package.json"), {
      name: "svc",
      scripts: { start: "node ." },
    });
    // plat/link -> outsideSvc: lexically inside the boundary, physically not
    try {
      fs.symlinkSync(outsideSvc, path.join(plat, "link"), "dir");
    } catch {
      t.skip("symlink creation unavailable on this platform");
      return;
    }
    writeJson(path.join(plat, "platform-map.local.json"), {
      locations: { svc: "link" },
    });

    const pm = await map(plat, { boundary: parent });
    const escapeDiag = pm.diagnostics.find(
      (d) =>
        d.code === "UNIT_PATH_ESCAPE" &&
        d.message.includes("escapes resolution boundary"),
    );
    assert.ok(escapeDiag, "physical escape must be diagnosed");
    const unit = pm.units.find((u) => u.name === "svc");
    assert.ok(unit);
    // never read: the outside package.json's signals must not appear
    assert.equal(unit.signals.hasStartScript, undefined);
    const missing = pm.diagnostics.find(
      (d) =>
        d.code === "PLATFORM_DRIFT" &&
        d.message.startsWith("PLATFORM_DRIFT: listed member missing:"),
    );
    assert.ok(missing, "escaped override treats the member as missing");
    assertNoAbsolutePaths(pm, parent);

    assert.equal(
      toJSON(await map(plat, { boundary: parent })),
      toJSON(await map(plat, { boundary: parent })),
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(outsideTree, { recursive: true, force: true });
  }
});

test("listed-but-missing member -> unit still emitted (identity exists) + PLATFORM_DRIFT warning", async () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    gitDir(plat);
    writeJson(path.join(plat, "platform-map.json"), {
      name: "acme",
      members: [{ name: "ghost-member" }],
    });

    const pm = await map(plat, { boundary: parent });
    assert.equal(pm.mode, "multi-repo");
    const unit = pm.units.find((u) => u.name === "ghost-member");
    assert.ok(unit, "identity exists even when location does not");
    assert.equal(unit.path, "ghost-member");
    assert.equal(unit.kind, "repo");
    assert.equal(unit.ref, null);
    const missing = pm.diagnostics.find(
      (d) =>
        d.code === "PLATFORM_DRIFT" &&
        d.message.startsWith("PLATFORM_DRIFT: listed member missing:"),
    );
    assert.ok(missing);
    assert.equal(missing.severity, "warning");
    assert.ok(missing.message.includes('"ghost-member"'));
    assertNoAbsolutePaths(pm, parent);

    assert.equal(
      toJSON(await map(plat, { boundary: parent })),
      toJSON(await map(plat, { boundary: parent })),
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("WR-03: a definition at the INVOKED root is honored regardless of boundary (full rung-3 semantics outside $HOME)", async () => {
  const parent = mktree();
  try {
    const plat = buildPlatform(parent);
    // NO boundary option: the tmpdir fixture is outside os.homedir(), so the
    // upward walk is inert — but the caller pointed map() directly at the
    // definition, which is always honored (same trust as a canonical config).
    const pm = await map(plat);
    assert.equal(pm.mode, "multi-repo");
    assert.equal(pm.name, "acme");
    assert.deepEqual(
      pm.units.map((u) => u.name),
      ["mono-lib", "plain-svc"],
    );
    assert.ok(pm.diagnostics.some((d) => d.code === "UNCONFIGURED_SIBLING"));
    assert.ok(
      pm.diagnostics.some(
        (d) => d.code === "PLATFORM_DRIFT" && d.severity === "info",
      ),
    );
    // byte-identical to the same tree mapped with an explicit boundary
    assert.equal(toJSON(pm), toJSON(await map(plat, { boundary: parent })));
    assert.equal(toJSON(await map(plat)), toJSON(await map(plat)));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("malformed platform-map.local.json -> MALFORMED_CONFIG warning, never a throw (per-user state cannot brick the map)", async () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    gitDir(plat);
    writeJson(path.join(plat, "platform-map.json"), {
      name: "acme",
      members: [{ name: "svc" }],
    });
    gitDir(path.join(plat, "svc"));
    fs.writeFileSync(path.join(plat, "platform-map.local.json"), "{{nope");

    const pm = await map(plat, { boundary: parent });
    const d = pm.diagnostics.find(
      (x) =>
        x.code === "MALFORMED_CONFIG" && x.path === "platform-map.local.json",
    );
    assert.ok(d);
    assert.equal(d.severity, "warning");
    assert.ok(!d.message.includes(parent));
    assertNoAbsolutePaths(pm, parent);

    assert.equal(
      toJSON(await map(plat, { boundary: parent })),
      toJSON(await map(plat, { boundary: parent })),
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("rung-1/2 firewall: a self-described repo inside a platform maps standalone, byte-identical to before", async () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    gitDir(plat);
    writeJson(path.join(plat, "platform-map.json"), {
      name: "acme",
      members: [{ name: "self-described" }],
    });
    const solo = path.join(plat, "self-described");
    gitDir(solo);
    // a unit-level config: this repo explicitly self-describes (rung 1/2)
    writeJson(path.join(solo, "platform-map.json"), { name: "my-own-name" });

    const pm = await map(solo, { boundary: parent });
    assert.equal(pm.root, solo); // NOT re-anchored to the platform root
    assert.equal(pm.name, "my-own-name");

    assert.equal(
      toJSON(await map(solo, { boundary: parent })),
      toJSON(await map(solo, { boundary: parent })),
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
