//..05: detect() classification, flavor probe, recursive
// composability, and the ref:null/no-subprocess invariant. Plain ESM
// .js importing the already-built dist/ — runs unmodified under
// `node --test` and `bun test`.
//
// Fixture strategy (test/fixtures/README.md): the four monorepo
// flavors + single-repo are asserted directly against the committed static
// fixtures (no .git needed — probeWorkspaceManifest short-circuits before
// any sibling scan happens). Anything needing a real `.git` entry
// (multi-repo classification,'s sibling-that-is-itself-a-monorepo
// proof, and the shuffled-readdir determinism check) is materialized in a
// temp directory here, seeded from the static fixtures, and removed after.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detect, RootNotFoundError } from "../dist/index.mjs";
import { looksLikeRepoRoot, scanSiblings } from "../dist/internal/scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");

function mkGitMarker(dir) {
  fs.mkdirSync(path.join(dir, ".git"));
}

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-detect-"));
}

function rmTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── mode classification + flavor probe order ────────────────────

test("detect() on a plain directory classifies single-repo", () => {
  const result = detect(path.join(fixturesDir, "single-repo"));
  assert.equal(result.mode, "single-repo");
  assert.equal(result.orchestrator, null);
});

test("detect() on a pnpm-workspace.yaml directory classifies monorepo/pnpm with raw globs", () => {
  const result = detect(path.join(fixturesDir, "monorepo-pnpm"));
  assert.equal(result.mode, "monorepo");
  assert.equal(result.flavor, "pnpm");
  assert.deepEqual(result.workspaceGlobs, [
    "packages/*",
    "apps/*",
    "!**/test/**",
  ]);
});

test("detect() disambiguates npm-workspaces (no yarn.lock/.yarnrc.yml)", () => {
  const result = detect(path.join(fixturesDir, "monorepo-npm-ws"));
  assert.equal(result.mode, "monorepo");
  assert.equal(result.flavor, "npm-workspaces");
  assert.deepEqual(result.workspaceGlobs, ["packages/*"]);
});

test("detect() disambiguates yarn-workspaces (yarn.lock present)", () => {
  const result = detect(path.join(fixturesDir, "monorepo-yarn-ws"));
  assert.equal(result.mode, "monorepo");
  assert.equal(result.flavor, "yarn-workspaces");
  assert.deepEqual(result.workspaceGlobs, ["packages/*"]);
});

test("detect() classifies lerna.json as flavor lerna", () => {
  const result = detect(path.join(fixturesDir, "monorepo-lerna"));
  assert.equal(result.mode, "monorepo");
  assert.equal(result.flavor, "lerna");
  assert.deepEqual(result.workspaceGlobs, ["packages/*"]);
});

// ── recursive composability + multi-repo/siblings ───────

test("multi-repo classification + composability + ref:null", () => {
  const tempRoot = mkTempDir();
  try {
    // Seed from the static multi-repo-of-monorepos fixture (sibling-b's
    // pnpm-workspace.yaml is committed; the .git markers are materialized
    // here per test/fixtures/README.md).
    fs.cpSync(path.join(fixturesDir, "multi-repo-of-monorepos"), tempRoot, {
      recursive: true,
    });
    mkGitMarker(path.join(tempRoot, "sibling-b"));

    // A second, non-monorepo sibling repo, to prove scanSiblings finds more
    // than just the composability fixture.
    const siblingC = path.join(tempRoot, "sibling-c");
    fs.mkdirSync(siblingC);
    mkGitMarker(siblingC);

    // A plain, non-.git directory — must NOT be picked up as a sibling.
    fs.mkdirSync(path.join(tempRoot, "not-a-repo"));

    // scanRoot: "." — `tempRoot` here plays the role of the shared parent
    // directory containing multiple sibling repos (sibling-b, sibling-c),
    // so siblings are found among ITS OWN children rather than its parent
    // (the default scanRoot ".." is for the common case of standing inside
    // one specific repo and discovering its neighbors — see DetectOptions).
    const multiRepo = detect(tempRoot, { scanRoot: "." });
    assert.equal(multiRepo.mode, "multi-repo");
    const names = multiRepo.siblings.map((s) => s.name).sort();
    assert.deepEqual(names, ["sibling-b", "sibling-c"]);

    // every sibling candidate has ref === null — no git subprocess.
    for (const sibling of multiRepo.siblings) {
      assert.equal(sibling.ref, null);
      assert.equal(sibling.conflict, null);
      assert.equal(typeof sibling.hasDfPointer, "boolean");
    }

    // detect() called again on sibling-b's own path reports
    // mode:"monorepo" — composability, not self-recursion inside detect().
    const nested = detect(path.join(tempRoot, "sibling-b"));
    assert.equal(nested.mode, "monorepo");
    assert.equal(nested.flavor, "pnpm");
  } finally {
    rmTempDir(tempRoot);
  }
});

test("sibling df-config.json is classified, not existence-checked: pointer-only sets hasDfPointer, full config populates conflict", () => {
  const tempRoot = mkTempDir();
  try {
    for (const name of ["ptr-sib", "full-sib", "bad-sib", "plain-sib"]) {
      const dir = path.join(tempRoot, name);
      fs.mkdirSync(dir);
      mkGitMarker(dir);
    }
    const writeDf = (sib, text) => {
      const factory = path.join(tempRoot, sib, ".factory");
      fs.mkdirSync(factory);
      fs.writeFileSync(path.join(factory, "df-config.json"), text);
    };
    writeDf(
      "ptr-sib",
      JSON.stringify({ platform: { factoryDir: ".factory" } }),
    );
    writeDf(
      "full-sib",
      JSON.stringify({ platform: { factoryDir: ".factory", repos: [] } }),
    );
    writeDf("bad-sib", "{not json");

    const d = detect(tempRoot, { scanRoot: "." });
    const byName = Object.fromEntries(d.siblings.map((s) => [s.name, s]));

    assert.equal(byName["ptr-sib"].hasDfPointer, true);
    assert.equal(byName["ptr-sib"].conflict, null);
    assert.equal(byName["full-sib"].hasDfPointer, false);
    assert.equal(
      byName["full-sib"].conflict,
      "df-config.json is a full config, not a pointer",
    );
    assert.equal(byName["bad-sib"].hasDfPointer, false);
    assert.equal(byName["bad-sib"].conflict, "df-config.json failed to parse");
    assert.equal(byName["plain-sib"].hasDfPointer, false);
    assert.equal(byName["plain-sib"].conflict, null);
  } finally {
    rmTempDir(tempRoot);
  }
});

test("detect() finds a real sibling under the documented default scanRoot '..' and never reports root as its own sibling (/ regression)", () => {
  // Regression coverage for this deliberately does NOT pass a
  // scanRoot override (unlike the composability test above, which uses
  // scanRoot: "." to sidestep the exact default code path that was broken)
  // — it exercises detect(root) with default options, the single most
  // common call shape, against a real .git-bearing sibling.
  const parent = mkTempDir();
  try {
    const rootApp = path.join(parent, "root-app");
    fs.mkdirSync(rootApp);
    mkGitMarker(rootApp);

    const sibling1 = path.join(parent, "sibling1");
    fs.mkdirSync(sibling1);
    mkGitMarker(sibling1);

    const result = detect(rootApp);
    assert.equal(result.mode, "multi-repo");
    assert.deepEqual(
      result.siblings.map((s) => s.name),
      ["sibling1"],
    );
    assert.equal(
      result.siblings.some((s) => s.name === "root-app" || s.path === "."),
      false,
    );
  } finally {
    rmTempDir(parent);
  }
});

// ── Error contract: the one Phase-1 throw case ──────────────────────────────

test("detect() on a nonexistent path throws RootNotFoundError", () => {
  assert.throws(
    () => detect(path.join(fixturesDir, "does-not-exist")),
    RootNotFoundError,
  );
});

test("RootNotFoundError never leaks the raw root when path.basename(root) is empty", () => {
  // path.basename("") === "" — the exact fallback branch that used to
  // reinstate the raw (potentially absolute) `root` argument verbatim.
  assert.throws(
    () => detect(""),
    (err) => {
      assert.ok(err instanceof RootNotFoundError);
      assert.equal(err.message, "platform-map: root not found: (root)");
      return true;
    },
  );
});

test("a malformed pnpm-workspace.yaml degrades gracefully, never throws", () => {
  const tempRoot = mkTempDir();
  try {
    fs.writeFileSync(
      path.join(tempRoot, "pnpm-workspace.yaml"),
      "packages: [a, b]\n",
    );
    let result;
    assert.doesNotThrow(() => {
      result = detect(tempRoot);
    });
    assert.equal(result.mode, "monorepo");
    assert.equal(result.flavor, "pnpm");
    assert.deepEqual(result.workspaceGlobs, []);
  } finally {
    rmTempDir(tempRoot);
  }
});

// ── no git subprocess anywhere in detect()'s call graph ─────────────

test("detect.ts and scan.ts import no child_process/spawn/git subprocess module", () => {
  const detectSrc = fs.readFileSync(
    path.join(here, "..", "src", "detect.ts"),
    "utf8",
  );
  const scanSrc = fs.readFileSync(
    path.join(here, "..", "src", "internal", "scan.ts"),
    "utf8",
  );
  for (const src of [detectSrc, scanSrc]) {
    assert.doesNotMatch(src, /child_process/);
    assert.doesNotMatch(src, /\bspawn\(/);
    assert.doesNotMatch(src, /execSync/);
  }
});

// ── scanSiblings is deterministic under reversed/shuffled readdir ─

test("scanSiblings sorts by name identically regardless of readdir order", () => {
  const tempRoot = mkTempDir();
  try {
    for (const name of ["zeta-repo", "alpha-repo", "mid-repo"]) {
      const dir = path.join(tempRoot, name);
      fs.mkdirSync(dir);
      mkGitMarker(dir);
    }

    const forward = scanSiblings(tempRoot, ".", undefined, () => [
      "alpha-repo",
      "mid-repo",
      "zeta-repo",
    ]);
    const reversed = scanSiblings(tempRoot, ".", undefined, () => [
      "zeta-repo",
      "mid-repo",
      "alpha-repo",
    ]);
    const shuffled = scanSiblings(tempRoot, ".", undefined, () => [
      "mid-repo",
      "zeta-repo",
      "alpha-repo",
    ]);

    const a = JSON.stringify(forward.siblings);
    const b = JSON.stringify(reversed.siblings);
    const c = JSON.stringify(shuffled.siblings);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.deepEqual(
      forward.siblings.map((s) => s.name),
      ["alpha-repo", "mid-repo", "zeta-repo"],
    );
  } finally {
    rmTempDir(tempRoot);
  }
});

// ── `ignore` is matched as a GLOB, not just an exact string ──────────

test("scanSiblings excludes siblings via an ignore glob and keeps exact-name ignores", () => {
  const tempRoot = mkTempDir();
  try {
    for (const name of ["web-repo", "api-repo", "tmp-repo"]) {
      const dir = path.join(tempRoot, name);
      fs.mkdirSync(dir);
      mkGitMarker(dir);
    }

    // A wildcard glob excludes every matching basename...
    const globbed = scanSiblings(tempRoot, ".", ["*-repo"], () => [
      "web-repo",
      "api-repo",
      "tmp-repo",
    ]);
    assert.deepEqual(
      globbed.siblings.map((s) => s.name),
      [],
      "the '*-repo' glob excludes all three siblings",
    );

    // ...while a bare literal still matches only itself (exact-name subset).
    const exact = scanSiblings(tempRoot, ".", ["api-repo"], () => [
      "web-repo",
      "api-repo",
      "tmp-repo",
    ]);
    assert.deepEqual(
      exact.siblings.map((s) => s.name).sort(),
      ["tmp-repo", "web-repo"],
      "an exact-name ignore excludes only that entry (glob subset)",
    );
  } finally {
    rmTempDir(tempRoot);
  }
});

// ── PMAP-014: sibling-candidate predicate + repo-root parity ────────

test("looksLikeRepoRoot accepts .git dir, .git file, or package.json; rejects plain dirs (PMAP-014)", () => {
  const tempRoot = mkTempDir();
  try {
    const gitDir = path.join(tempRoot, "git-dir");
    fs.mkdirSync(gitDir);
    mkGitMarker(gitDir);

    // Submodule/worktree shape: .git is a FILE (gitlink), not a directory.
    const gitFile = path.join(tempRoot, "git-file");
    fs.mkdirSync(gitFile);
    fs.writeFileSync(path.join(gitFile, ".git"), "gitdir: ../elsewhere\n");

    const pkgOnly = path.join(tempRoot, "pkg-only");
    fs.mkdirSync(pkgOnly);
    fs.writeFileSync(path.join(pkgOnly, "package.json"), "{}");

    const plain = path.join(tempRoot, "plain");
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, "notes.md"), "");

    assert.equal(looksLikeRepoRoot(gitDir), true);
    assert.equal(looksLikeRepoRoot(gitFile), true);
    assert.equal(looksLikeRepoRoot(pkgOnly), true);
    assert.equal(looksLikeRepoRoot(plain), false);
  } finally {
    rmTempDir(tempRoot);
  }
});

test("scanSiblings default gate stays .git-only; injected looksLikeRepoRoot widens to package.json (PMAP-014)", () => {
  const tempRoot = mkTempDir();
  try {
    const gitSib = path.join(tempRoot, "git-sib");
    fs.mkdirSync(gitSib);
    mkGitMarker(gitSib);

    const pkgSib = path.join(tempRoot, "pkg-sib");
    fs.mkdirSync(pkgSib);
    fs.writeFileSync(path.join(pkgSib, "package.json"), "{}");

    const plain = path.join(tempRoot, "plain");
    fs.mkdirSync(plain);

    const names = ["git-sib", "pkg-sib", "plain"];

    // Default predicate: 0.1.0 behavior byte-preserved — .git children only.
    const dflt = scanSiblings(tempRoot, ".", undefined, () => names);
    assert.deepEqual(
      dflt.siblings.map((s) => s.name),
      ["git-sib"],
    );

    // Widened predicate: package.json-only children qualify; plain dirs never do.
    const widened = scanSiblings(
      tempRoot,
      ".",
      undefined,
      () => names,
      looksLikeRepoRoot,
    );
    assert.deepEqual(
      widened.siblings.map((s) => s.name),
      ["git-sib", "pkg-sib"],
    );
  } finally {
    rmTempDir(tempRoot);
  }
});

test("scanSiblings drops a hostile readdir entry that escapes the scan directory with UNIT_PATH_ESCAPE", () => {
  const tempRoot = mkTempDir();
  try {
    // The expected single-level climb of `scanRoot: ".."` itself must NOT
    // be treated as an escape (that was the bug) — a genuine escape
    // can only come from a hostile/crafted entry NAME smuggling extra ".."
    // segments beyond the resolved scan directory (a real fs.readdirSync()
    // entry is always a bare basename, but the readdir seam is injectable
    // for exactly this defense-in-depth test). The name must not start
    // with "." (or the dotfile filter would skip it before the guard ever
    // runs), so the escape is embedded mid-name instead.
    const result = scanSiblings(tempRoot, ".", undefined, () => [
      "sibling/../../../../../../etc",
    ]);
    assert.deepEqual(result.siblings, []);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].code, "UNIT_PATH_ESCAPE");
  } finally {
    rmTempDir(tempRoot);
  }
});
