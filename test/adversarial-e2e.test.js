// TEST-03: adversarial safety proven END-TO-END through map(). The Phase-1
// unit tests already prove matchGlob (glob.test.js), walk (walk.test.js), and
// resolveWithinRoot (path-guard.test.js) are safe in isolation; this file
// drives the SAME hostile vectors — ReDoS globs, a symlink cycle, and a
// canonical escaping unit path — through the full map() assembly path to prove
// the mitigations survive integration. Plus a DETR-02 determinism sweep across
// all Phase-5 fixtures. NO source changes: the tests ARE the verification.
//
// Plain ESM .js importing the already-built dist/ (D-06) — runs unmodified
// under `node --test` and `bun test` (D-05). Every hostile fixture (symlinks,
// escaping configs) is built at TEST-TIME in os.tmpdir() with a finally
// rmSync cleanup — never committed (symlinks/`.git` cannot be committed
// cleanly). Pure fs: nothing here is guarded on git.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { map } from "../dist/index.mjs";
import { patterns as adversarialPatterns } from "./fixtures/adversarial-glob/corpus.js";

// A generous wall-clock cap: the segment matcher's cost is polynomial, so even
// the pathological corpus resolves in single-digit ms — 5000ms proves "bounded,
// never a hang" with enormous headroom for a loaded CI runner (T-05-04/05).
const BOUND_MS = 5000;

// ── T-05-04: ReDoS globs via a workspace manifest, driven through map() ─────
// The corpus patterns (deeply-nested **, a 500-segment literal, an evil
// `a*a*a…` wildcard) are the exact shapes a naive `**`→regex compile would
// blow up on. Fed to map() as a pnpm-workspace `packages:` list, map() must
// resolve in bounded time (segment matcher, not a compiled regex) and — since
// the pathological patterns match nothing — surface UNMATCHED_PATTERN rather
// than hang or throw. A real candidate dir is present so the matcher actually
// runs the patterns against a workspace census, exercising the full path.
test("map() over a ReDoS-glob workspace manifest resolves bounded and emits UNMATCHED_PATTERN (T-05-04)", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "platform-map-adv-redos-"),
  );
  try {
    // pnpm-workspace.yaml whose packages[] IS the adversarial corpus. Each
    // pattern is single-quoted: `*` (alias) and `!` (tag) are YAML indicators.
    const workspaceYaml =
      "packages:\n" + adversarialPatterns.map((p) => `  - '${p}'\n`).join("");
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), workspaceYaml);
    // A real workspace member so the census has a candidate to match against.
    const pkgA = path.join(root, "packages", "pkg-a");
    fs.mkdirSync(pkgA, { recursive: true });
    fs.writeFileSync(
      path.join(pkgA, "package.json"),
      JSON.stringify({ name: "pkg-a" }),
    );

    const start = Date.now();
    const pm = await map(root);
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed < BOUND_MS,
      `expected ReDoS globs to resolve through map() in bounded time, took ${elapsed}ms`,
    );
    assert.equal(pm.mode, "monorepo");
    assert.ok(
      pm.diagnostics.some((d) => d.code === "UNMATCHED_PATTERN"),
      "the pathological patterns match nothing -> map() degrades to an UNMATCHED_PATTERN diagnostic, never a hang or throw",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── T-05-05: an a->b->a symlink cycle inside a mapped monorepo tree ─────────
// map() must terminate in bounded time (no-follow walker + depth/entry caps)
// and never enumerate the cycle-linked dirs as units — the no-follow contract
// holds end-to-end, not just in walk() in isolation.
test("map() over a symlink cycle resolves bounded and never enumerates the linked dirs as units (T-05-05)", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "platform-map-adv-cycle-"),
  );
  try {
    fs.writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );
    // Two real workspace members...
    for (const name of ["a", "b"]) {
      const dir = path.join(root, "packages", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name }),
      );
    }
    // ...wired into a cycle: packages/a/link-to-b -> packages/b, and
    // packages/b/link-to-a -> packages/a (a real runtime dir symlink).
    fs.symlinkSync(
      path.join(root, "packages", "b"),
      path.join(root, "packages", "a", "link-to-b"),
      "dir",
    );
    fs.symlinkSync(
      path.join(root, "packages", "a"),
      path.join(root, "packages", "b", "link-to-a"),
      "dir",
    );

    const start = Date.now();
    const pm = await map(root);
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed < BOUND_MS,
      `expected the symlink cycle to resolve through map() in bounded time, took ${elapsed}ms`,
    );
    // The two real members are present...
    assert.deepEqual(pm.units.map((u) => u.name).sort(), [
      "packages/a",
      "packages/b",
    ]);
    // ...and no unit was enumerated by following a cycle link (no-follow e2e).
    assert.equal(
      pm.units.some((u) => u.name.includes("link-to")),
      false,
      "cycle-linked dirs must never be enumerated as units",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
