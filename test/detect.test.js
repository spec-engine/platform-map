// DET-01..05: detect() classification, flavor probe, DET-02 recursive
// composability, and the DET-05 ref:null/no-subprocess invariant. Plain ESM
// .js importing the already-built dist/ (D-06) — runs unmodified under
// `node --test` and `bun test` (D-05).
//
// Fixture strategy (D-07, test/fixtures/README.md): the four monorepo
// flavors + single-repo are asserted directly against the committed static
// fixtures (no .git needed — probeWorkspaceManifest short-circuits before
// any sibling scan happens). Anything needing a real `.git` entry
// (multi-repo classification, DET-02's sibling-that-is-itself-a-monorepo
// proof, and the shuffled-readdir determinism check) is materialized in a
// temp directory here, seeded from the static fixtures, and removed after.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detect, RootNotFoundError } from "../dist/index.mjs";
import { scanSiblings } from "../dist/internal/scan.mjs";

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

// ── DET-01/03: mode classification + flavor probe order ────────────────────

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

// ── DET-02: recursive composability + DET-04/05: multi-repo/siblings ───────

test("multi-repo classification + DET-02 composability + DET-05 ref:null", () => {
  const tempRoot = mkTempDir();
  try {
    // Seed from the static multi-repo-of-monorepos fixture (sibling-b's
    // pnpm-workspace.yaml is committed; the .git markers are materialized
    // here per D-07/test/fixtures/README.md).
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

    // DET-05: every sibling candidate has ref === null — no git subprocess.
    for (const sibling of multiRepo.siblings) {
      assert.equal(sibling.ref, null);
      assert.equal(sibling.conflict, null);
      assert.equal(typeof sibling.hasDfPointer, "boolean");
    }

    // DET-02: detect() called again on sibling-b's own path reports
    // mode:"monorepo" — composability, not self-recursion inside detect().
    const nested = detect(path.join(tempRoot, "sibling-b"));
    assert.equal(nested.mode, "monorepo");
    assert.equal(nested.flavor, "pnpm");
  } finally {
    rmTempDir(tempRoot);
  }
});

test("detect() finds a real sibling under the documented default scanRoot '..' and never reports root as its own sibling (CR-01/CR-02 regression)", () => {
  // Regression coverage for CR-01/CR-02: this deliberately does NOT pass a
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

// ── DET-05: no git subprocess anywhere in detect()'s call graph ─────────────

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

// ── DETR-02: scanSiblings is deterministic under reversed/shuffled readdir ─

test("scanSiblings sorts by name identically regardless of readdir order (DETR-02)", () => {
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

test("scanSiblings drops a hostile readdir entry that escapes the scan directory with UNIT_PATH_ESCAPE (CR-01)", () => {
  const tempRoot = mkTempDir();
  try {
    // The expected single-level climb of `scanRoot: ".."` itself must NOT
    // be treated as an escape (that was the CR-01 bug) — a genuine escape
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
