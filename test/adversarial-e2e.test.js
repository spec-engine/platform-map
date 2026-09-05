// adversarial safety proven END-TO-END through map(). The
// unit tests already prove matchGlob (glob.test.js), walk (walk.test.js), and
// resolveWithinRoot (path-guard.test.js) are safe in isolation; this file
// drives the SAME hostile vectors — ReDoS globs, a symlink cycle, and a
// canonical escaping unit path — through the full map() assembly path to prove
// the mitigations survive integration. Plus a determinism sweep across
// all committed fixtures. NO source changes: the tests ARE the verification.
//
// Plain ESM .js importing the already-built dist/ — runs unmodified
// under `node --test` and `bun test`. Every hostile fixture (symlinks,
// escaping configs) is built at TEST-TIME in os.tmpdir() with a finally
// rmSync cleanup — never committed (symlinks/`.git` cannot be committed
// cleanly). Pure fs: nothing here is guarded on git.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { map } from "../dist/index.mjs";
import { toJSON } from "../dist/internal/serialize.mjs";
import { patterns as adversarialPatterns } from "./fixtures/adversarial-glob/corpus.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");

// A generous wall-clock cap: the segment matcher's cost is polynomial, so even
// the pathological corpus resolves in single-digit ms — 5000ms proves "bounded,
// never a hang" with enormous headroom for a loaded CI runner (05).
const BOUND_MS = 5000;

// helper: assert map(root) is byte-identical across two invocations and
// that no absolute path leaks into the DERIVED structure. The top-level `root`
// field is the one documented echo of the input root (serialize.ts: unit paths
// are "root-relative only") — it is deterministic given the same input, so it is
// excluded before the leak check; every unit path / edge / diagnostic must be
// root-relative, never carrying `absNeedle`.
async function assertDeterministicAndRootRelative(label, root, absNeedle) {
  const first = toJSON(await map(root));
  const second = toJSON(await map(root));
  assert.equal(
    first,
    second,
    `${label}: toJSON(map(root)) must be byte-identical across two invocations`,
  );
  const { root: _echoedRoot, ...derived } = JSON.parse(first);
  assert.equal(
    JSON.stringify(derived).includes(absNeedle),
    false,
    `${label}: no absolute path may leak into unit paths / edges / diagnostics (only the documented top-level root echo is absolute)`,
  );
}

// ── ReDoS globs via a workspace manifest, driven through map() ─────
// The corpus patterns (deeply-nested **, a 500-segment literal, an evil
// `a*a*a…` wildcard) are the exact shapes a naive `**`→regex compile would
// blow up on. Fed to map() as a pnpm-workspace `packages:` list, map() must
// resolve in bounded time (segment matcher, not a compiled regex) and — since
// the pathological patterns match nothing — surface UNMATCHED_PATTERN rather
// than hang or throw. A real candidate dir is present so the matcher actually
// runs the patterns against a workspace census, exercising the full path.
test("map() over a ReDoS-glob workspace manifest resolves bounded and emits UNMATCHED_PATTERN", async () => {
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

// ── an a->b->a symlink cycle inside a mapped monorepo tree ─────────
// map() must terminate in bounded time (no-follow walker + depth/entry caps)
// and never enumerate the cycle-linked dirs as units — the no-follow contract
// holds end-to-end, not just in walk() in isolation.
test("map() over a symlink cycle resolves bounded and never enumerates the linked dirs as units", async () => {
  // Wrapper dir isolates the run from concurrent tests' tmpdir fixtures.
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "platform-map-adv-cycle-"),
  );
  const root = path.join(parent, "root");
  fs.mkdirSync(root);
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
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// ── a canonical config declaring an ESCAPING unit path ─────────────
// the path-escape guard is unconditional: even when the escaping `../../etc` path is authored
// canonical intent (not a hostile injected caller unit), resolveWithinRoot drops
// the unit and emits UNIT_PATH_ESCAPE. Canonical authority does not override the
// path guard — proven here through the full map() assembly, not resolveWithinRoot
// in isolation.
test("map() drops a canonical unit whose declared path escapes root with UNIT_PATH_ESCAPE", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "platform-map-adv-escape-"),
  );
  try {
    // A well-formed canonical config (valid name/mode so parsing SUCCEEDS — the
    // ESCAPE, not a parse error, is what must trigger the drop) declaring a unit
    // whose path walks out of the root.
    fs.writeFileSync(
      path.join(root, "platform-map.json"),
      JSON.stringify({
        name: "hostile-host",
        mode: "multi-repo",
        units: [{ name: "evil", path: "../../etc" }],
      }),
    );

    const pm = await map(root);

    assert.equal(
      pm.units.some((u) => u.name === "evil"),
      false,
      "an escaping canonical unit path must be dropped, even as authored intent",
    );
    assert.ok(
      pm.diagnostics.some((d) => d.code === "UNIT_PATH_ESCAPE"),
      "expected a UNIT_PATH_ESCAPE diagnostic (the path-escape guard is unconditional)",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── determinism sweep across all committed fixtures ──────────
// The serializer is the sole sort site, so byte-identical toJSON across two runs
// is the determinism proof (one sort seam). Committed fixtures cover the three
// Phase-5 topologies; a rebuilt temp monorepo covers the adversarial-tree shape.
// Each fixture also asserts no absolute path leaks into the derived structure.
test("map() output is byte-identical across runs with no absolute-path leak, for every committed committed fixtures", async () => {
  for (const name of [
    "synthetic-spec-engine",
    "monorepo-turbo",
    "multi-repo-of-monorepos",
  ]) {
    const root = path.join(fixturesDir, name);
    await assertDeterministicAndRootRelative(name, root, root);
  }
});

test("map() over a rebuilt temp monorepo is byte-identical across runs with no tmpdir-path leak", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-adv-detr-"));
  try {
    fs.writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );
    for (const name of ["alpha", "beta"]) {
      const dir = path.join(root, "packages", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name }),
      );
    }
    await assertDeterministicAndRootRelative("temp-monorepo", root, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
