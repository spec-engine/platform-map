// Bun smoke test. Proves the built package works when run by Bun.
//
// Why this is a separate file instead of running test/ under `bun test`:
// Bun's node:test support rejects a test that starts while another one is
// still running (oven-sh/bun#5090), and several files in test/ do that. So
// test/ runs on Node only, and this file runs on Bun only. It uses Bun's own
// test API and exercises the real public surface (detect() and toJSON()).
//
// Why `.spec.mjs` in `test-bun/`: `node --test` does not pick up `.spec.`
// files or this directory, while `bun test test-bun/` does. Each runner sees
// exactly the files it can run.

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
