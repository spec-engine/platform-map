// CFG-03/CFG-09/SEC-01: map() end-to-end — single-repo assembly, MapOptions
// caller-unit injection, adapter toggles, determinism, and the only-throw
// contract (RootNotFoundError). Plain ESM .js importing the already-built
// dist/ (D-06) — runs unmodified under `node --test` and `bun test` (D-05).
//
// Authored in plan 02-01 Task 1 as the failing e2e that drives Task 3: until
// map() is exported from dist/index.mjs these assertions fail (map undefined).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MalformedConfigError,
  map,
  RootNotFoundError,
} from "../dist/index.mjs";
import { toJSON } from "../dist/internal/serialize.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const singleRepo = path.join(fixturesDir, "single-repo");
const monorepoPnpm = path.join(fixturesDir, "monorepo-pnpm");

function gitAvailable() {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
const GIT = gitAvailable();

// ── CFG-03: single-repo happy path ─────────────────────────────────────────

test("map() on a single-repo tree returns a deterministic PlatformMap", async () => {
  const pm = await map(singleRepo);
  assert.equal(pm.schemaVersion, 1);
  assert.equal(pm.mode, "single-repo");
  assert.equal(pm.name, "single-repo");
  assert.deepEqual(pm.edges, []);
  assert.ok(Array.isArray(pm.units));
  assert.ok(Array.isArray(pm.diagnostics));
});

// ── CFG-09: caller-injected units enter as source:"caller" ─────────────────

test('map() injects MapOptions.units as source "caller"', async () => {
  const pm = await map(singleRepo, { units: [{ name: "x", path: "x" }] });
  const unit = pm.units.find((u) => u.name === "x");
  assert.ok(unit, "expected injected unit 'x' to be present");
  assert.ok(
    unit.sources.includes("caller"),
    `expected sources to include "caller", got ${JSON.stringify(unit.sources)}`,
  );
  assert.equal(unit.role, "unknown"); // role is Phase 3; seeded "unknown" here
  assert.equal(unit.ref, null);
});

// ── T-02-01: an injected path escaping root is dropped + diagnosed ─────────

test("map() drops an injected unit whose path escapes root with UNIT_PATH_ESCAPE", async () => {
  const pm = await map(singleRepo, {
    units: [{ name: "evil", path: "../../../../etc" }],
  });
  assert.equal(
    pm.units.some((u) => u.name === "evil"),
    false,
    "escaping injected unit must not be present",
  );
  assert.ok(
    pm.diagnostics.some((d) => d.code === "UNIT_PATH_ESCAPE"),
    "expected a UNIT_PATH_ESCAPE diagnostic",
  );
});

// ── CFG-09: adapter toggle runs cleanly (no adapters registered yet) ───────

test("map() honors a MapOptions.adapters disable toggle without error", async () => {
  await assert.doesNotReject(() =>
    map(singleRepo, { adapters: { siblings: false } }),
  );
});

// ── Determinism: byte-identical across repeated calls ──────────────────────

test("map() output is byte-identical across two invocations", async () => {
  const a = toJSON(await map(singleRepo));
  const b = toJSON(await map(singleRepo));
  assert.equal(a, b);
});

// ── CFG-06: monorepo e2e — workspace-package units + fs signal census ──────

test("map() enumerates workspace-package units with signals for a monorepo", async () => {
  const pm = await map(monorepoPnpm);
  assert.equal(pm.mode, "monorepo");

  const names = pm.units.map((u) => u.name);
  assert.deepEqual(names, [
    "apps/app-a",
    "packages/bad-name",
    "packages/nested-mono",
    "packages/pkg-a",
  ]);
  for (const unit of pm.units) {
    assert.equal(unit.kind, "workspace-package");
    assert.deepEqual(unit.sources, ["workspace"]);
  }

  // Phase 3 (03-03): roles are now DERIVED, not seeded "unknown". With no
  // cross-package deps in this fixture every degree is 0, so only pkg-a — which
  // carries a start script + Dockerfile — fires deriveRole rule 1 -> "app"; the
  // rest have no discriminating signal and fall through to rule 5 -> "unknown".
  const roleByName = Object.fromEntries(pm.units.map((u) => [u.name, u.role]));
  assert.deepEqual(roleByName, {
    "apps/app-a": "unknown",
    "packages/bad-name": "unknown",
    "packages/nested-mono": "unknown",
    "packages/pkg-a": "app",
  });

  // pkg-a carries the full package.json + fs signal census.
  const pkgA = pm.units.find((u) => u.name === "packages/pkg-a");
  assert.equal(pkgA.signals.packageName, "@scope/pkg-a");
  assert.equal(pkgA.signals.private, true);
  assert.equal(pkgA.signals.hasExports, true);
  assert.equal(pkgA.signals.hasBin, true);
  assert.equal(pkgA.signals.hasStartScript, true);
  assert.equal(pkgA.signals.hasDockerfile, true);
  assert.deepEqual([...pkgA.signals.languages].sort(), ["js", "ts"]);
});

test("map() keeps a unit with an invalid package name and emits MALFORMED_CONFIG (SEC-03)", async () => {
  const pm = await map(monorepoPnpm);
  const badName = pm.units.find((u) => u.name === "packages/bad-name");
  assert.ok(badName, "the unit with an invalid package name is still present");
  assert.equal(Object.hasOwn(badName.signals, "packageName"), false);
  assert.ok(
    pm.diagnostics.some(
      (d) => d.code === "MALFORMED_CONFIG" && /Has Space/.test(d.message ?? ""),
    ),
    "expected a MALFORMED_CONFIG diagnostic for the invalid package name",
  );
});

// WR-01: the invalid-package-name diagnostic carries the unit's
// platform-relative locus (not just the raw name in the message).
test("map() stamps the unit path onto an invalid-package-name diagnostic (WR-01)", async () => {
  const pm = await map(monorepoPnpm);
  const malformed = pm.diagnostics.find(
    (d) => d.code === "MALFORMED_CONFIG" && /Has Space/.test(d.message ?? ""),
  );
  assert.ok(malformed, "expected the invalid-name MALFORMED_CONFIG diagnostic");
  assert.equal(
    malformed.path,
    "packages/bad-name",
    "diagnostic carries the unit's platform-relative locus",
  );
});

test("map() recurses into a nested monorepo (DET-02) with workspace-only children", async () => {
  const pm = await map(monorepoPnpm);
  const nested = pm.units.find((u) => u.name === "packages/nested-mono");
  assert.ok(nested, "nested monorepo unit present");
  assert.equal(nested.mode, "monorepo");
  assert.equal(nested.units.length, 1);
  const [leaf] = nested.units;
  assert.equal(leaf.name, "packages/nested-mono/packages/leaf");
  assert.equal(leaf.kind, "workspace-package");
  // Nested children come ONLY from workspace expansion — never phantom
  // sibling/DF/SE sub-units at any nested level.
  assert.deepEqual(leaf.sources, ["workspace"]);
});

// WR-03: DET-02 composability — a promoted kind:"repo" constituent that is
// itself a monorepo must report mode:"monorepo" at its own node with its
// workspace-package children expanded (workspace-only, never phantom sub-units).
test("map() expands a multi-repo constituent that is itself a monorepo to mode:monorepo (WR-03/DET-02)", async () => {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "platform-map-monosib-"),
  );
  try {
    // A sibling repo (has .git) that is ALSO a pnpm monorepo of its own.
    const monoSib = path.join(parent, "mono-sib");
    fs.mkdirSync(path.join(monoSib, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(monoSib, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );
    const innerPkg = path.join(monoSib, "packages", "inner-pkg");
    fs.mkdirSync(innerPkg, { recursive: true });
    fs.writeFileSync(
      path.join(innerPkg, "package.json"),
      JSON.stringify({ name: "inner-pkg" }),
    );

    // A plain non-repo workdir map() is pointed at; detect() finds mono-sib as
    // its sibling (default scanRoot "..") -> multi-repo at the top node.
    const workdir = path.join(parent, "workdir");
    fs.mkdirSync(workdir);

    const pm = await map(workdir);
    assert.equal(pm.mode, "multi-repo");

    const sib = pm.units.find((u) => u.name === "mono-sib");
    assert.ok(sib, "the monorepo sibling is promoted to a unit");
    assert.equal(sib.kind, "repo");
    assert.equal(
      sib.mode,
      "monorepo",
      "a repo constituent that is itself a monorepo reports mode:monorepo (WR-03)",
    );
    assert.equal(sib.units.length, 1, "its workspace child is expanded");
    const [child] = sib.units;
    assert.equal(child.name, "mono-sib/packages/inner-pkg");
    assert.equal(child.kind, "workspace-package");
    // Workspace-expansion-only: the child comes solely from the workspace
    // adapter — never a phantom sibling/DF/SE sub-unit.
    assert.deepEqual(child.sources, ["workspace"]);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("map() surfaces UNMATCHED_PATTERN (not a throw) when a workspace glob matches nothing", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-map-"));
  try {
    fs.writeFileSync(
      path.join(tempRoot, "pnpm-workspace.yaml"),
      "packages:\n  - 'does-not-exist/*'\n",
    );
    let pm;
    await assert.doesNotReject(async () => {
      pm = await map(tempRoot);
    });
    assert.equal(pm.mode, "monorepo");
    assert.ok(
      pm.diagnostics.some((d) => d.code === "UNMATCHED_PATTERN"),
      "expected an UNMATCHED_PATTERN diagnostic",
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("map() monorepo output is byte-identical across two invocations", async () => {
  const a = toJSON(await map(monorepoPnpm));
  const b = toJSON(await map(monorepoPnpm));
  assert.equal(a, b);
});

// ── CFG-07/MODEL-06: zero-config multi-repo — sibling promotion + ref probe ─

test("map() promotes zero-config sibling repos to units with map()-resolved refs (CFG-07/MODEL-06)", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-multi-"));
  try {
    // repo-a: a real git repo whose origin/HEAD -> main, so the map()-loop probe
    // resolves ref:"main" (when git is available); otherwise a bare .git marker.
    const repoA = path.join(parent, "repo-a");
    fs.mkdirSync(repoA);
    let expectA = null;
    if (GIT) {
      spawnSync("git", ["init", "-q"], { cwd: repoA, stdio: "ignore" });
      spawnSync(
        "git",
        [
          "symbolic-ref",
          "refs/remotes/origin/HEAD",
          "refs/remotes/origin/main",
        ],
        { cwd: repoA, stdio: "ignore" },
      );
      expectA = "main";
    } else {
      fs.mkdirSync(path.join(repoA, ".git"));
    }

    // repo-b: a bare .git marker (an "absent git repo") — the ref probe must
    // degrade it to ref:null promptly and never stall the batch (T-02-10).
    const repoB = path.join(parent, "repo-b");
    fs.mkdirSync(path.join(repoB, ".git"), { recursive: true });

    // workdir: a plain, non-repo child we point map() at; detect() then finds
    // repo-a/repo-b as its siblings (default scanRoot "..").
    const workdir = path.join(parent, "workdir");
    fs.mkdirSync(workdir);

    const pm = await map(workdir);
    assert.equal(pm.mode, "multi-repo");

    const names = pm.units.map((u) => u.name).sort();
    assert.deepEqual(names, ["repo-a", "repo-b"]);
    for (const unit of pm.units) {
      // canonicalDeclaredUnits is false -> provisional siblings are promoted.
      assert.equal(unit.kind, "repo");
      assert.ok(unit.sources.includes("siblings"));
      // ref is a string or null, never the literal "origin/HEAD".
      assert.ok(unit.ref === null || typeof unit.ref === "string");
      assert.notEqual(unit.ref, "origin/HEAD");
    }

    const a = pm.units.find((u) => u.name === "repo-a");
    const b = pm.units.find((u) => u.name === "repo-b");
    assert.equal(a.ref, expectA);
    assert.equal(b.ref, null);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("map() resolves a sibling's ref:null concurrently without stalling on an absent-git repo", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-multi-"));
  try {
    // Three bare-.git-marker siblings: none is a real repo, so every probe
    // degrades to null. The whole map() must still resolve promptly.
    for (const name of ["a", "b", "c"]) {
      fs.mkdirSync(path.join(parent, name, ".git"), { recursive: true });
    }
    const workdir = path.join(parent, "workdir");
    fs.mkdirSync(workdir);

    const start = Date.now();
    const pm = await map(workdir);
    assert.ok(
      Date.now() - start < 10000,
      "map() must resolve within the bounded probe window",
    );
    assert.equal(pm.mode, "multi-repo");
    assert.deepEqual(pm.units.map((u) => u.name).sort(), ["a", "b", "c"]);
    for (const unit of pm.units) assert.equal(unit.ref, null);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// ── SEC-01: nonexistent root is the only throw path so far ─────────────────

test("map() on a nonexistent root rejects with RootNotFoundError", async () => {
  await assert.rejects(
    () => map(path.join(fixturesDir, "does-not-exist")),
    RootNotFoundError,
  );
});

// WR-04: the post-merge census + monorepo recursion must run under the SAME
// SEC-01 two-error discipline as the adapter fold — only RootNotFoundError and
// MalformedConfigError may escape map(); any other throw from the census/
// recursion path degrades to a diagnostic. censusSignals/workspaceAdapter/merge
// are all designed not to throw today (no runtime seam forces a throw), so this
// is a defense-in-depth structural guard: it asserts the enrichment loop is
// wrapped so a future regression cannot leak an arbitrary error out of map().
test("map() runs the post-merge census/recursion under the SEC-01 throw guard (WR-04)", () => {
  const src = fs.readFileSync(path.join(here, "..", "src", "map.ts"), "utf8");
  // Scope to the region between merge() and the ref-probe Promise.all.
  const start = src.indexOf("const merged = merge(");
  const end = src.indexOf("await Promise.all");
  assert.ok(
    start !== -1 && end !== -1 && end > start,
    "post-merge region found",
  );
  const region = src.slice(start, end);
  assert.match(region, /for \(const unit of merged\.units\)/);
  assert.match(region, /try\s*{/, "enrichment loop is wrapped in try/catch");
  assert.match(region, /error instanceof RootNotFoundError/);
  assert.match(region, /error instanceof MalformedConfigError/);
  assert.match(region, /throw error/, "the two hard errors are re-thrown");
});

// The behavioral half of WR-04: exercising the now-guarded census + nested
// monorepo recursion still resolves (never rejects) — the guard does not change
// the happy path.
test("map() still resolves cleanly over the guarded census + recursion path (WR-04)", async () => {
  await assert.doesNotReject(() => map(monorepoPnpm));
});

// ── CFG-01/CFG-02/SEC-01: canonical platform-map.json authority ────────────

function writeCanonical(dir, config) {
  fs.writeFileSync(
    path.join(dir, "platform-map.json"),
    typeof config === "string" ? config : JSON.stringify(config),
  );
}

// A canonical config declaring units[] disposes: unconfirmed siblings become
// UNCONFIGURED_SIBLING diagnostics, not promoted units (Pattern 3 promotion gate).
test("map() with a canonical units[] suppresses sibling promotion (UNCONFIGURED_SIBLING)", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-canon-"));
  try {
    // Two sibling repos in the parent that WOULD be promoted without canonical.
    for (const name of ["repo-a", "repo-b"]) {
      fs.mkdirSync(path.join(parent, name, ".git"), { recursive: true });
    }
    const workdir = path.join(parent, "workdir");
    fs.mkdirSync(path.join(workdir, "pkg"), { recursive: true });
    // Canonical declares one in-root unit -> declaredUnits gate fires.
    writeCanonical(workdir, { units: [{ name: "pkg", path: "pkg" }] });

    const pm = await map(workdir);

    const pkg = pm.units.find((u) => u.name === "pkg");
    assert.ok(pkg, "declared canonical unit 'pkg' is authoritative");
    assert.ok(
      pkg.sources.includes("canonical"),
      `expected 'canonical' source, got ${JSON.stringify(pkg.sources)}`,
    );
    // Siblings are NOT promoted to units.
    assert.equal(
      pm.units.some((u) => u.name === "repo-a" || u.name === "repo-b"),
      false,
      "siblings must not be promoted when canonical declares units[]",
    );
    assert.ok(
      pm.diagnostics.some((d) => d.code === "UNCONFIGURED_SIBLING"),
      "expected UNCONFIGURED_SIBLING diagnostics for the suppressed siblings",
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// Gate is not inverted: a canonical config WITHOUT units[] still promotes siblings.
test("map() with a canonical config but no units[] still promotes siblings", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-canon-"));
  try {
    fs.mkdirSync(path.join(parent, "repo-a", ".git"), { recursive: true });
    const workdir = path.join(parent, "workdir");
    fs.mkdirSync(workdir, { recursive: true });
    writeCanonical(workdir, { name: "labeled" }); // no units[]

    const pm = await map(workdir);
    assert.equal(
      pm.name,
      "labeled",
      "canonical name is authoritative (CFG-01)",
    );
    assert.ok(
      pm.units.some(
        (u) => u.name === "repo-a" && u.sources.includes("siblings"),
      ),
      "sibling must still be promoted when canonical declares no units[]",
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// SEC-01 hard error #2: a PRESENT-but-malformed canonical config throws.
test("map() rejects with MalformedConfigError on a malformed platform-map.json", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-canon-"));
  try {
    writeCanonical(root, "{ this is not valid json");
    await assert.rejects(() => map(root), MalformedConfigError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// SEC-01 asymmetry: a malformed ADAPTER source degrades to a diagnostic while a
// VALID canonical config is applied — map() resolves, never throws.
test("map() resolves (with MALFORMED_CONFIG) when an adapter source is malformed but canonical is valid", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-canon-"));
  try {
    fs.writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );
    fs.mkdirSync(path.join(root, "packages", "bad"), { recursive: true });
    // Invalid package name -> SEC-03 adapter-level MALFORMED_CONFIG (not a throw).
    fs.writeFileSync(
      path.join(root, "packages", "bad", "package.json"),
      JSON.stringify({ name: "Bad Name" }),
    );
    writeCanonical(root, { name: "still-ok" });

    let pm;
    await assert.doesNotReject(async () => {
      pm = await map(root);
    });
    assert.equal(pm.name, "still-ok", "valid canonical name is applied");
    assert.ok(
      pm.diagnostics.some((d) => d.code === "MALFORMED_CONFIG"),
      "expected a MALFORMED_CONFIG diagnostic from the degraded adapter source",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Overrides honesty (Assumption A3): an override naming no assembled unit warns
// and is ignored — never throws — and role stays "unknown" this phase.
test("map() warns and ignores a canonical override naming a non-existent unit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-canon-"));
  try {
    fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
    writeCanonical(root, {
      units: [{ name: "pkg", path: "pkg" }],
      overrides: { "ghost-unit": { role: "app" } },
    });

    let pm;
    await assert.doesNotReject(async () => {
      pm = await map(root);
    });
    assert.ok(
      pm.diagnostics.some(
        (d) =>
          d.severity === "warning" &&
          d.code === "MALFORMED_CONFIG" &&
          /ghost-unit/.test(d.message ?? ""),
      ),
      "expected a warning diagnostic naming the stale override",
    );
    for (const u of pm.units) assert.equal(u.role, "unknown");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── CFG-05: spec-engine platform e2e — members glob expands into sub-units ──

function writeMember(dir, config) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "spec-engine.member.json"),
    typeof config === "string" ? config : JSON.stringify(config),
  );
}

test("map() infers spec-engine sub-member units from a members glob with no platform-map.json", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-se-"));
  try {
    writeMember(root, { specs: "spec-engine@3", members: "packages/*" });
    fs.mkdirSync(path.join(root, "packages", "engine"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages", "cli"), { recursive: true });

    const pm = await map(root);

    const subMembers = pm.units.filter((u) =>
      ["packages/cli", "packages/engine"].includes(u.path),
    );
    assert.deepEqual(
      subMembers.map((u) => u.path).sort(),
      ["packages/cli", "packages/engine"],
      "both sub-member directories become units",
    );
    for (const unit of subMembers) {
      assert.equal(unit.signals.hasSpecEngineConfig, true);
      assert.ok(unit.sources.includes("spec-engine"));
      assert.equal(unit.role, "unknown");
    }
    // `specs`/pin never leaks into any unit or signal.
    assert.equal(/spec-engine@3/.test(JSON.stringify(pm.units)), false);
    assert.deepEqual(pm.edges, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// SEC-03: a spec-engine sub-member whose package.json name is invalid keeps the
// unit (identity is its path) and drops only the packageName signal, via map()'s
// map-owned census — proving SEC-03 re-applies to SE members end-to-end.
test("map() keeps a spec-engine sub-member with an invalid package name and drops packageName (SEC-03)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-se-"));
  try {
    writeMember(root, { specs: "spec-engine@3", members: "packages/*" });
    const bad = path.join(root, "packages", "bad");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(
      path.join(bad, "package.json"),
      JSON.stringify({ name: "Invalid Name!!" }),
    );

    const pm = await map(root);
    const unit = pm.units.find((u) => u.path === "packages/bad");
    assert.ok(unit, "the sub-member is still present");
    assert.equal(Object.hasOwn(unit.signals, "packageName"), false);
    assert.ok(
      pm.diagnostics.some((d) => d.code === "MALFORMED_CONFIG"),
      "expected a MALFORMED_CONFIG diagnostic for the invalid package name",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── CFG-04: dark-factory platform e2e — platform.repos[] become units ──────

function writeDfConfig(dir, config) {
  const factoryDir = path.join(dir, ".factory");
  fs.mkdirSync(factoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(factoryDir, "df-config.json"),
    typeof config === "string" ? config : JSON.stringify(config),
  );
}

test("map() infers platform.repos[] units from a dark-factory platform with no platform-map.json", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-df-"));
  try {
    fs.mkdirSync(path.join(root, "svc-api"), { recursive: true });
    fs.mkdirSync(path.join(root, "ui"), { recursive: true });
    writeDfConfig(root, {
      platform: {
        factoryDir: ".factory",
        repos: [
          { name: "svc-api", path: "svc-api", kind: "repo", dependsOn: ["ui"] },
          { name: "ui", path: "ui", kind: "repo", dependsOn: [] },
        ],
      },
    });

    const pm = await map(root);
    const names = pm.units.map((u) => u.name).sort();
    assert.deepEqual(names, ["svc-api", "ui"]);
    for (const unit of pm.units) {
      assert.equal(unit.kind, "repo");
      assert.ok(unit.sources.includes("dark-factory"));
      assert.equal(unit.role, "unknown");
    }
    // dependsOn[] never becomes an edge (Phase 3).
    assert.deepEqual(pm.edges, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Precedence: canonical outranks dark-factory. A path disagreement on the same
// unit name surfaces a CONFIG_CONFLICT and canonical's value wins.
test("map() resolves a canonical-vs-dark-factory path disagreement in canonical's favor (CONFIG_CONFLICT)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-df-"));
  try {
    fs.mkdirSync(path.join(root, "svc-canonical"), { recursive: true });
    fs.mkdirSync(path.join(root, "svc-df"), { recursive: true });
    writeCanonical(root, {
      units: [{ name: "svc", path: "svc-canonical" }],
    });
    writeDfConfig(root, {
      platform: {
        repos: [{ name: "svc", path: "svc-df", kind: "repo", dependsOn: [] }],
      },
    });

    const pm = await map(root);
    const svc = pm.units.find((u) => u.name === "svc");
    assert.ok(svc, "unit 'svc' present");
    assert.equal(svc.path, "svc-canonical", "canonical path wins the conflict");
    assert.ok(svc.sources.includes("canonical"));
    assert.ok(svc.sources.includes("dark-factory"));
    const conflict = pm.diagnostics.find((d) => d.code === "CONFIG_CONFLICT");
    assert.ok(conflict, "expected a CONFIG_CONFLICT diagnostic");
    assert.match(conflict.message, /canonical/);
    assert.match(conflict.message, /dark-factory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// MODEL-06 declared-ref-wins: a canonical unit declaring a ref keeps it unprobed;
// a canonical unit without a ref is resolved by map()'s per-unit probe loop —
// proving MODEL-06 applies to ALL kind:"repo" units, not only siblings.
test("map() keeps a canonical declared ref and probes a canonical unit that omits ref", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-canon-"));
  try {
    const pinned = path.join(root, "pinned");
    const probed = path.join(root, "probed");
    fs.mkdirSync(pinned, { recursive: true });
    fs.mkdirSync(probed, { recursive: true });
    let expectProbed = null;
    if (GIT) {
      spawnSync("git", ["init", "-q"], { cwd: probed, stdio: "ignore" });
      spawnSync(
        "git",
        [
          "symbolic-ref",
          "refs/remotes/origin/HEAD",
          "refs/remotes/origin/main",
        ],
        { cwd: probed, stdio: "ignore" },
      );
      expectProbed = "main";
    } else {
      fs.mkdirSync(path.join(probed, ".git"));
    }
    writeCanonical(root, {
      units: [
        { name: "pinned", path: "pinned", ref: "pinned-ref" },
        { name: "probed", path: "probed" },
      ],
    });

    const pm = await map(root);
    const pinnedUnit = pm.units.find((u) => u.name === "pinned");
    const probedUnit = pm.units.find((u) => u.name === "probed");
    assert.equal(pinnedUnit.ref, "pinned-ref", "declared ref wins (unprobed)");
    assert.equal(
      probedUnit.ref,
      expectProbed,
      "ref-less canonical unit is resolved by map()'s MODEL-06 probe",
    );
    assert.notEqual(probedUnit.ref, "origin/HEAD");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
