// darkFactoryAdapter — the adapter-level unit contract. White-box tests
// importing the built adapter directly from dist/adapters/dark-factory.mjs (the
// Phase-2 test-build seam, not the public exports map). Verifies the verbatim
// pointer-only predicate (exact key-count checks), the dfConfigConflict signal
// for a present-but-non-pointer config, platform.repos[] -> kind:"repo" units
// (dependsOn ignored, edges []), the path-escape drop, and the
// malformed-degrades-to-diagnostic (never throw) contract. The dark-factory platform e2e
// (repos become units; canonical wins a conflict) lives in map.test.js.
//
// Fixtures are materialized in temp dirs at runtime rather than committed under
// test/fixtures/: Dark Factory's config lives at `<root>/.factory/df-config.json` and the
// repo's .gitignore globally ignores `.factory/`, so a committed static fixture
// could not be tracked. Temp-dir materialization matches the established
// canonical.test.js / map.test.js pattern and sidesteps the ignore entirely.
//
// Plain ESM .js over dist/ — runs unmodified under `node --test` and
// `bun test`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { darkFactoryAdapter } from "../dist/adapters/dark-factory.mjs";

// darkFactoryAdapter reads <root>/.factory/df-config.json and ignores its ctx
// argument (linkage facts come from the file, not the detection frame).
const STUB_CTX = {
  detection: { mode: "single-repo" },
  ignore: [],
  options: {},
};

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-df-"));
}

function writeDfConfig(dir, config) {
  const factoryDir = path.join(dir, ".factory");
  fs.mkdirSync(factoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(factoryDir, "df-config.json"),
    typeof config === "string" ? config : JSON.stringify(config),
  );
}

// ── absent df-config.json = empty result ───────────────────────────────────

test("darkFactoryAdapter returns an empty result when no .factory/df-config.json exists", () => {
  const root = mkTempDir();
  try {
    const result = darkFactoryAdapter(root, STUB_CTX);
    assert.deepEqual(result.partialUnits, []);
    assert.deepEqual(result.edges, []);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── pointer-only predicate (exact key-count) -> hasDfPointer, NO repos ──────

test("darkFactoryAdapter sets hasDfPointer for an exact pointer-only config and emits no repo units", () => {
  const root = mkTempDir();
  try {
    writeDfConfig(root, { platform: { factoryDir: "../platform/.factory" } });
    const result = darkFactoryAdapter(root, STUB_CTX);

    assert.equal(result.partialUnits.length, 1);
    const [pu] = result.partialUnits;
    assert.equal(pu.signals.hasDfPointer, true);
    assert.equal(Object.hasOwn(pu.signals, "dfConfigConflict"), false);
    assert.equal(pu.path, ".", "pointer signal attaches to the platform root");
    assert.equal(pu.source, "dark-factory");
    assert.deepEqual(result.edges, []);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("darkFactoryAdapter treats an extra top-level key as a non-pointer conflict", () => {
  const root = mkTempDir();
  try {
    // Two top-level keys -> fails the exact-one-key check -> not pointer-only.
    writeDfConfig(root, {
      platform: { factoryDir: ".factory" },
      extra: true,
    });
    const result = darkFactoryAdapter(root, STUB_CTX);
    assert.equal(result.partialUnits.length, 1);
    assert.equal(result.partialUnits[0].signals.dfConfigConflict, true);
    assert.equal(
      Object.hasOwn(result.partialUnits[0].signals, "hasDfPointer"),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("darkFactoryAdapter treats an extra platform key as a non-pointer conflict", () => {
  const root = mkTempDir();
  try {
    // platform has TWO keys -> fails the inner exact-one-key check.
    writeDfConfig(root, {
      platform: { factoryDir: ".factory", name: "acme" },
    });
    const result = darkFactoryAdapter(root, STUB_CTX);
    assert.equal(result.partialUnits[0].signals.dfConfigConflict, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── non-pointer, no repos[] -> dfConfigConflict ────────────────────────────

test("darkFactoryAdapter sets dfConfigConflict for a present-but-non-pointer config", () => {
  const root = mkTempDir();
  try {
    writeDfConfig(root, { someOtherTool: { setting: 1 } });
    const result = darkFactoryAdapter(root, STUB_CTX);
    assert.equal(result.partialUnits.length, 1);
    assert.equal(result.partialUnits[0].signals.dfConfigConflict, true);
    assert.equal(result.partialUnits[0].path, ".");
    assert.deepEqual(result.diagnostics, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── full config: platform.repos[] -> kind:"repo" units, dependsOn NOT edges ─

test("darkFactoryAdapter maps platform.repos[] to kind:'repo' units and ignores dependsOn", () => {
  const root = mkTempDir();
  try {
    writeDfConfig(root, {
      platform: {
        factoryDir: ".factory",
        repos: [
          { name: "svc-api", path: "svc-api", kind: "repo", dependsOn: ["ui"] },
          {
            name: "ui",
            path: "ui",
            ref: "release/2.x",
            kind: "repo",
            dependsOn: [],
          },
        ],
      },
    });
    const result = darkFactoryAdapter(root, STUB_CTX);

    assert.equal(result.partialUnits.length, 2);
    const byName = Object.fromEntries(
      result.partialUnits.map((u) => [u.name, u]),
    );
    assert.equal(byName["svc-api"].kind, "repo");
    assert.equal(byName["svc-api"].path, "svc-api");
    assert.equal(byName["svc-api"].source, "dark-factory");
    // dependsOn must NOT become an edge — edges are Phase 3.
    assert.deepEqual(result.edges, []);
    // A declared ref is carried through; a ref-less repo leaves ref undefined.
    assert.equal(byName.ui.ref, "release/2.x");
    assert.equal(Object.hasOwn(byName["svc-api"], "ref"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── a repo path escaping the root is dropped + diagnosed ──

test("darkFactoryAdapter drops a repo whose declared path escapes the root", () => {
  const root = mkTempDir();
  try {
    writeDfConfig(root, {
      platform: {
        repos: [
          { name: "ok", path: "ok", kind: "repo", dependsOn: [] },
          {
            name: "evil",
            path: "../../../../etc",
            kind: "repo",
            dependsOn: [],
          },
        ],
      },
    });
    const result = darkFactoryAdapter(root, STUB_CTX);
    assert.deepEqual(
      result.partialUnits.map((u) => u.name),
      ["ok"],
      "escaping repo must be dropped, in-root repo kept",
    );
    assert.ok(
      result.diagnostics.some((d) => d.code === "UNIT_PATH_ESCAPE"),
      "expected a UNIT_PATH_ESCAPE diagnostic for the escaping repo path",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── malformed df-config.json -> MALFORMED_CONFIG diagnostic, never throw ────

test("darkFactoryAdapter degrades a malformed df-config.json to a MALFORMED_CONFIG diagnostic", () => {
  const root = mkTempDir();
  try {
    writeDfConfig(root, "{ this is not valid json");
    let result;
    assert.doesNotThrow(() => {
      result = darkFactoryAdapter(root, STUB_CTX);
    });
    assert.deepEqual(result.partialUnits, []);
    assert.ok(
      result.diagnostics.some((d) => d.code === "MALFORMED_CONFIG"),
      "expected a MALFORMED_CONFIG diagnostic",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── determinism: the adapter never sorts its own output ────────────────────

test("darkFactoryAdapter never sorts its own output (serialize.ts is the sole sort site)", () => {
  const src = fs.readFileSync(
    path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "src",
      "adapters",
      "dark-factory.ts",
    ),
    "utf8",
  );
  const nonComment = src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  assert.equal(nonComment.includes(".sort("), false);
});
