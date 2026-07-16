// RED-96 verification-pass invariants (PMAP-001/002/005): properties over ALL
// committed fixtures, readdir-driven so future fixtures are auto-covered.
//
// Plain ESM .js importing the already-built dist/ (D-06) — runs unmodified
// under `node --test` (D-05). NEVER src/, NEVER .ts (Node 20 has no TS
// stripping and tsdown can't run on Node 20).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { map } from "../dist/index.mjs";
import { toJSON } from "../dist/internal/serialize.mjs";

// NOTE (Pitfall 3): dist/internal/serialize.mjs is imported here only because
// the node:test lane runs against the full dist/. It is NOT shipped in the
// tarball — the cold-install smoke exercises the public exports only.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const distDir = path.join(here, "..", "dist");

// Recursively collect every unit.name at all depths.
function collectUnitNames(units, acc = []) {
  for (const u of units) {
    acc.push(u.name);
    if (u.units.length > 0) collectUnitNames(u.units, acc);
  }
  return acc;
}

// Recursive filesystem snapshot: [relPath, isDir, size, mtimeMs] sorted by
// relPath. lstat (never follow symlinks) so the snapshot itself is inert.
function snapshot(root) {
  const entries = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const st = fs.lstatSync(abs);
      entries.push([
        path.relative(root, abs),
        st.isDirectory(),
        st.size,
        st.mtimeMs,
      ]);
      if (st.isDirectory()) walk(abs);
    }
  };
  walk(root);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries;
}

// ── PMAP-001/002: all-fixtures determinism sweep + global uniqueness ─────────
// readdir-driven: every committed fixture directory is swept, so new fixtures
// are auto-covered without touching this file. `siblings: false` keeps the
// sweep hermetic — otherwise mapping a fixture scans test/fixtures/.. itself.
test("map() is byte-identical across two runs and unit names are globally unique, for EVERY committed fixture (PMAP-001/002)", async () => {
  const fixtures = fs
    .readdirSync(fixturesDir, { withFileTypes: true })
    .filter((ent) => ent.isDirectory())
    .map((ent) => ent.name)
    .sort();
  assert.ok(fixtures.length > 0, "no fixture directories found");

  for (const name of fixtures) {
    const dir = path.join(fixturesDir, name);
    const a = await map(dir, { adapters: { siblings: false } });
    const b = await map(dir, { adapters: { siblings: false } });
    assert.equal(
      toJSON(a),
      toJSON(b),
      `non-deterministic output for fixture ${name}`,
    );

    // Exactly-once invariant: unit names unique at all depths (PMAP-002).
    const names = collectUnitNames(a.units);
    assert.equal(
      new Set(names).size,
      names.length,
      `duplicate unit names in fixture ${name}: ${names.join(", ")}`,
    );
  }
});

// ── PMAP-005: no-write audit ─────────────────────────────────────────────────
// map() must never write to the mapped tree. Full before/after filesystem
// snapshot (paths, dir-ness, sizes, mtimes) around map() over copies of the
// two richest committed fixtures. CLI `init` refusal is covered separately in
// test/cli.test.js.
test("map() performs no filesystem writes on the mapped tree (PMAP-005 no-write audit)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-nowrite-"));
  try {
    for (const fixture of ["single-repo", "monorepo-pnpm"]) {
      const copyDir = path.join(tmp, fixture);
      fs.cpSync(path.join(fixturesDir, fixture), copyDir, { recursive: true });

      const before = snapshot(copyDir);
      await map(copyDir);
      const after = snapshot(copyDir);

      assert.deepEqual(
        after,
        before,
        `map() modified the filesystem under ${fixture}`,
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── PMAP-005: static no-network audit ────────────────────────────────────────
// The built artifacts must contain no network-module references.
// node:child_process IS expected (the bounded git ref probe — see
// exec.test.js); network modules are not.
test("built dist/ artifacts contain no network-module references (PMAP-005 static no-network audit)", () => {
  const forbidden = [
    /node:https?/,
    /node:net\b/,
    /node:tls/,
    /node:dgram/,
    /node:dns/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /\bfetch\s*\(/,
  ];
  for (const artifact of ["index.mjs", "index.cjs", "platform-map.mjs"]) {
    const source = fs.readFileSync(path.join(distDir, artifact), "utf8");
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(source),
        false,
        `dist/${artifact} matches forbidden network pattern ${pattern}`,
      );
    }
  }
});
