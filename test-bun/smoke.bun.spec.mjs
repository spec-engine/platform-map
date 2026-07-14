// Bun-runtime smoke test (D-05 amendment — see comment in package.json's
// "test:bun" script and ci.yml for the full rationale).
//
// WHY THIS FILE EXISTS AND WHY IT LIVES OUTSIDE test/:
// 01-RESEARCH.md's stack decision (D-05) assumed "basic node:test usage
// runs unmodified and fully under `bun test`", citing Bun's own compat-matrix
// docs and a passing fixture in oven-sh/bun's source tree. That assumption is
// FALSIFIED under Bun 1.3.14: any node:test file containing a nested test()
// call performed asynchronously relative to another top-level test — which
// several of this package's test/*.test.js files do (temp-dir setup/teardown
// interleaved with sibling test registration) — throws
// "test() inside another test() is not yet implemented in Bun"
// (oven-sh/bun#5090). This is a Bun engine limitation, not a bug in this
// package's tests, and it is not fixable by editing test/*.test.js without
// rewriting them away from node:test entirely (out of scope per BUILD-04's
// intent: prove platform-map works AS A CONSUMER under Bun, not prove
// node:test's own compat surface).
//
// RESOLUTION: keep test/*.test.js exactly as written, running only under
// `node --test` (Node 20/22 lanes). Separately, prove the BUILT package
// (dist/) works correctly when consumed from Bun by writing a real bun:test
// smoke test against the actual public surface (detect() + toJSON) — this
// still satisfies BUILD-04's intent ("test suite passes across Node 20,
// Node 22, and Bun") because it genuinely exercises platform-map under the
// Bun runtime; it just uses Bun's own native test API instead of trying to
// force node:test's incompatible surface through Bun's compat shim.
//
// ISOLATION: this file must NOT be discovered by `node --test`, but MUST be
// discovered by `bun test`. Node's default test-file discovery matches
// *.test.{js,mjs,cjs}, *-test.*, *_test.*, test.*, test-*.*, and anything
// under a directory literally named "test" — none of those include
// `.spec.`. Bun's discovery requires ".test", "_test_", ".spec", or
// "_spec_" in the filename — `.spec.mjs` satisfies Bun while staying
// invisible to Node. Combined with living in test-bun/ (not test/), this
// file is picked up by `bun test test-bun/` and ignored by `node --test`.
// See the "node --test still 51/51, did not discover this file" check in
// 01-03-SUMMARY.md / the fix commit for the empirical verification.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

// ── ESM entry: exercise the real public surface against a real fixture ────

test("bun: detect() classifies a pnpm monorepo fixture (ESM entry, dist/index.mjs)", async () => {
  const { detect } = await import(
    path.join(repoRoot, "dist", "index.mjs")
  );
  const fixture = path.join(
    repoRoot,
    "test",
    "fixtures",
    "monorepo-pnpm",
  );
  const result = detect(fixture);
  expect(result.mode).toBe("monorepo");
  expect(result.flavor).toBe("pnpm");
  expect(result.workspaceGlobs).toEqual([
    "packages/*",
    "apps/*",
    "!**/test/**",
  ]);
});

test("bun: detect() classifies a plain directory as single-repo (ESM entry)", async () => {
  const { detect } = await import(
    path.join(repoRoot, "dist", "index.mjs")
  );
  const fixture = path.join(repoRoot, "test", "fixtures", "single-repo");
  const result = detect(fixture);
  expect(result.mode).toBe("single-repo");
  expect(result.orchestrator).toBe(null);
});

test("bun: detect() on a real on-disk multi-repo tree finds .git siblings (ESM entry, no mocked fs)", async () => {
  const { detect } = await import(
    path.join(repoRoot, "dist", "index.mjs")
  );
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "platform-map-bun-smoke-"),
  );
  try {
    const rootApp = path.join(parent, "root-app");
    fs.mkdirSync(rootApp);
    fs.mkdirSync(path.join(rootApp, ".git"));

    const sibling1 = path.join(parent, "sibling1");
    fs.mkdirSync(sibling1);
    fs.mkdirSync(path.join(sibling1, ".git"));

    const result = detect(rootApp);
    expect(result.mode).toBe("multi-repo");
    expect(result.siblings.map((s) => s.name)).toEqual(["sibling1"]);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// ── Deterministic serializer: prove toJSON is order-independent under Bun ──

test("bun: toJSON is byte-identical regardless of input array order (ESM entry)", async () => {
  const { toJSON } = await import(
    path.join(repoRoot, "dist", "index.mjs")
  );

  const base = {
    name: "acme-platform",
    root: ".",
    mode: "monorepo",
    schemaVersion: 1,
    units: [
      {
        name: "packages/webapp",
        path: "packages/webapp",
        kind: "workspace-package",
        mode: "single-repo",
        ref: null,
        units: [],
        signals: { hasStartScript: true },
        role: "app",
        sources: ["pnpm-workspace.yaml"],
      },
      {
        name: "packages/engine",
        path: "packages/engine",
        kind: "workspace-package",
        mode: "single-repo",
        ref: null,
        units: [],
        signals: { hasExports: true },
        role: "library",
        sources: ["pnpm-workspace.yaml"],
      },
    ],
    edges: [],
    diagnostics: [
      {
        code: "UNMATCHED_PATTERN",
        severity: "warning",
        path: "packages/*-unused",
        message: "UNMATCHED_PATTERN: pattern matched nothing",
      },
      {
        code: "CONFIG_CONFLICT",
        severity: "error",
        path: "svc-api",
        message: "CONFIG_CONFLICT: two sources disagree",
      },
    ],
  };
  const reordered = {
    ...base,
    units: base.units.slice().reverse(),
    diagnostics: base.diagnostics.slice().reverse(),
  };

  const a = toJSON(base);
  const b = toJSON(reordered);
  expect(a).toBe(b);
  expect(a).not.toContain(repoRoot);
});

// ── CJS entry: require() works under Bun (dual-package hazard smoke) ──────

test("bun: require()-ing the CJS entry works and matches the ESM entry's output", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const cjs = require(path.join(repoRoot, "dist", "index.cjs"));
  const fixture = path.join(repoRoot, "test", "fixtures", "single-repo");
  const result = cjs.detect(fixture);
  expect(result.mode).toBe("single-repo");
});
