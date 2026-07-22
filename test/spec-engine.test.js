// CFG-05: specEngineAdapter — the adapter-level unit contract. White-box tests
// importing the built adapter directly from dist/adapters/spec-engine.mjs (the
// Phase-2 test-build seam). Verifies: a member.json sets hasSpecEngineConfig;
// a `members` glob expands into sub-member units with platform-relative names;
// glob matches that are files or a basename `spec-engine` dir are skipped;
// `ignore` NEVER filters expansion (RED-108 AC4 — scan-only, SE parity); a
// malformed member config degrades to a MALFORMED_CONFIG diagnostic (never
// throws); and an expanded path escaping the root is dropped (SEC-02). The file-skip / spec-engine-skip / SEC-02 branches
// use the adapter's TEST-ONLY `deps` seam (mirrors the workspace adapter); the
// happy-path expansion runs against a real temp-dir tree. The SE-platform e2e
// lives in map.test.js.
//
// Plain ESM .js over dist/ (D-06) — runs unmodified under `node --test` and
// `bun test` (D-05).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { specEngineAdapter } from "../dist/adapters/spec-engine.mjs";

const STUB_CTX = {
  detection: { mode: "single-repo" },
  ignore: [],
  options: {},
};

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-se-"));
}

function writeMember(dir, config) {
  fs.writeFileSync(
    path.join(dir, "spec-engine.member.json"),
    typeof config === "string" ? config : JSON.stringify(config),
  );
}

// ── absent member.json = empty result ──────────────────────────────────────

test("specEngineAdapter returns an empty result when no spec-engine.member.json exists", () => {
  const root = mkTempDir();
  try {
    const result = specEngineAdapter(root, STUB_CTX);
    assert.deepEqual(result.partialUnits, []);
    assert.deepEqual(result.edges, []);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── a member.json (no members glob) -> one member unit, hasSpecEngineConfig ──

test("specEngineAdapter emits a member unit with hasSpecEngineConfig and discards specs/pin", () => {
  const root = mkTempDir();
  try {
    writeMember(root, { specs: "spec-engine@3", ignore: ["dist"] });
    const result = specEngineAdapter(root, STUB_CTX);

    assert.equal(result.partialUnits.length, 1);
    const [member] = result.partialUnits;
    assert.equal(member.signals.hasSpecEngineConfig, true);
    assert.equal(member.path, ".");
    assert.equal(member.kind, "workspace-package");
    assert.equal(member.source, "spec-engine");
    // `specs`/pin never leaks into any unit or signal.
    const serialized = JSON.stringify(result);
    assert.equal(/spec-engine@3/.test(serialized), false);
    assert.equal(Object.hasOwn(member.signals, "specs"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── members glob -> sub-member units with platform-relative "<parent>/<rel>" ─

test("specEngineAdapter expands a members glob into platform-relative sub-member units", () => {
  const root = mkTempDir();
  try {
    const parent = path.basename(root);
    writeMember(root, { specs: "spec-engine@3", members: "packages/*" });
    fs.mkdirSync(path.join(root, "packages", "engine"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages", "cli"), { recursive: true });

    const result = specEngineAdapter(root, STUB_CTX);

    // The root member plus the two sub-members.
    const subs = result.partialUnits.filter((u) => u.path !== ".");
    const byPath = Object.fromEntries(subs.map((u) => [u.path, u]));
    assert.deepEqual(Object.keys(byPath).sort(), [
      "packages/cli",
      "packages/engine",
    ]);
    assert.equal(byPath["packages/engine"].name, `${parent}/packages/engine`);
    assert.equal(byPath["packages/engine"].kind, "workspace-package");
    assert.equal(byPath["packages/engine"].signals.hasSpecEngineConfig, true);
    assert.equal(byPath["packages/engine"].source, "spec-engine");
    assert.deepEqual(result.edges, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── a file match and a basename `spec-engine` dir are NOT emitted ───────────

test("specEngineAdapter skips a glob match that is a file or a spec-engine dir", () => {
  const root = mkTempDir();
  try {
    writeMember(root, { specs: "spec-engine@3", members: "packages/*" });
    // Inject walk + isDir: one real dir, one file, one spec-engine dir.
    const result = specEngineAdapter(root, STUB_CTX, {
      walk: () => ({
        entries: [
          "packages/engine",
          "packages/README.md",
          "packages/spec-engine",
        ],
        diagnostics: [],
      }),
      isDir: (absPath) => !absPath.endsWith("README.md"),
    });
    const subs = result.partialUnits.filter((u) => u.path !== ".");
    assert.deepEqual(
      subs.map((u) => u.path),
      ["packages/engine"],
      "only the real, non-spec-engine directory becomes a sub-member",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── RED-108 (AC4): `ignore` NEVER filters expansion — scan-only, SE parity ──

test("specEngineAdapter emits every matched sub-member regardless of the ignore array (RED-108 AC4)", () => {
  const root = mkTempDir();
  try {
    writeMember(root, {
      specs: "spec-engine@3",
      members: "packages/*",
      // Basename, rel-path, and glob forms — none of them may filter
      // expansion: SE's expandWorkspaceMembers takes no ignore parameter,
      // and the member config's ignore is a tag-scan hint, not membership.
      ignore: ["cli", "packages/engine", "packages/*"],
    });
    const result = specEngineAdapter(root, STUB_CTX, {
      walk: () => ({
        entries: ["packages/engine", "packages/cli"],
        diagnostics: [],
      }),
      isDir: () => true,
    });
    const subs = result.partialUnits.filter((u) => u.path !== ".");
    assert.deepEqual(
      subs.map((u) => u.path).sort(),
      ["packages/cli", "packages/engine"],
      "the ignore array is discarded — both sub-members are emitted",
    );
    // The ignore entries never leak into any unit or signal either.
    const serialized = JSON.stringify(result.partialUnits);
    assert.equal(/tag-scan|"ignore"/.test(serialized), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── SEC-02 (T-02-22): an expanded path escaping the root is dropped ─────────

test("specEngineAdapter drops an expanded sub-member escaping the root with UNIT_PATH_ESCAPE", () => {
  const root = mkTempDir();
  try {
    writeMember(root, { specs: "spec-engine@3", members: "**" });
    const result = specEngineAdapter(root, STUB_CTX, {
      walk: () => ({
        entries: ["../escape", "packages/ok"],
        diagnostics: [],
      }),
      isDir: () => true,
    });
    const subs = result.partialUnits.filter((u) => u.path !== ".");
    assert.equal(
      subs.some((u) => u.path.includes("..")),
      false,
      "escaping sub-member must not become a unit",
    );
    assert.ok(subs.some((u) => u.path === "packages/ok"));
    assert.ok(
      result.diagnostics.some((d) => d.code === "UNIT_PATH_ESCAPE"),
      "expected a UNIT_PATH_ESCAPE diagnostic",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── malformed member config -> MALFORMED_CONFIG diagnostic, never throw ─────

test("specEngineAdapter degrades a malformed member config to a MALFORMED_CONFIG diagnostic", () => {
  const root = mkTempDir();
  try {
    writeMember(root, "{ not valid json ");
    let result;
    assert.doesNotThrow(() => {
      result = specEngineAdapter(root, STUB_CTX);
    });
    assert.deepEqual(result.partialUnits, []);
    assert.ok(result.diagnostics.some((d) => d.code === "MALFORMED_CONFIG"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── determinism: the adapter never sorts its own output ────────────────────

test("specEngineAdapter never sorts its own output and never uses Bun.Glob", () => {
  const src = fs.readFileSync(
    path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "src",
      "adapters",
      "spec-engine.ts",
    ),
    "utf8",
  );
  const nonComment = src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  assert.equal(nonComment.includes(".sort("), false);
  assert.equal(nonComment.includes("Bun.Glob"), false);
});
