// canonicalAdapter — the adapter-level unit contract. White-box tests
// importing the built adapter directly from dist/adapters/canonical.mjs (the
// Phase-2 test-build seam, not the public exports map). Verifies units[] ->
// PartialUnit mapping, the path-escape drop, the declaredUnits promotion-gate
// flag, and declared-ref carry-through. The e2e canonical behavior (throw
// asymmetry, promotion gate, overrides warning, ref probe) is proven in
// map.test.js; this file pins the adapter's own output shape. Plain ESM .js
// over dist/ — runs unmodified under `node --test` and `bun test`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { canonicalAdapter } from "../dist/adapters/canonical.mjs";

// canonicalAdapter reads <root>/platform-map.json and ignores its ctx argument
// (config-level facts come from the file, not the detection frame). A minimal
// stub context is sufficient for these white-box tests.
const STUB_CTX = {
  detection: { mode: "single-repo" },
  ignore: [],
  options: {},
};

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-canonical-"));
}
function writeCanonical(dir, config) {
  fs.writeFileSync(
    path.join(dir, "platform-map.json"),
    typeof config === "string" ? config : JSON.stringify(config),
  );
}

// ── absent config = empty result, no side-channel promotion ────────────────

test("canonicalAdapter returns an empty result when no platform-map.json exists", () => {
  const root = mkTempDir();
  try {
    const result = canonicalAdapter(root, STUB_CTX);
    assert.deepEqual(result.partialUnits, []);
    assert.deepEqual(result.edges, []);
    assert.deepEqual(result.diagnostics, []);
    // Absent config never sets the promotion gate.
    assert.equal(result.canonical, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── units[] -> PartialUnit kind:"repo" source:"canonical" + side-channel ───

test("canonicalAdapter maps units[] to canonical PartialUnits and surfaces name/overrides", () => {
  const root = mkTempDir();
  try {
    writeCanonical(root, {
      name: "acme",
      units: [{ name: "svc", path: "svc" }],
      overrides: { svc: { role: "app" } },
    });
    const result = canonicalAdapter(root, STUB_CTX);

    assert.equal(result.partialUnits.length, 1);
    const [pu] = result.partialUnits;
    assert.equal(pu.name, "svc");
    assert.equal(pu.path, "svc");
    assert.equal(pu.kind, "repo");
    assert.equal(pu.source, "canonical");
    assert.deepEqual(result.edges, []);

    assert.ok(result.canonical, "expected a canonical side-channel");
    assert.equal(result.canonical.name, "acme");
    assert.equal(result.canonical.declaredUnits, true);
    assert.deepEqual(result.canonical.overrides, { svc: { role: "app" } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── declaredUnits is false when units[] is absent or empty ─────────────────

test("canonicalAdapter reports declaredUnits:false for an empty units[]", () => {
  const root = mkTempDir();
  try {
    writeCanonical(root, { name: "x", units: [] });
    const result = canonicalAdapter(root, STUB_CTX);
    assert.equal(result.partialUnits.length, 0);
    assert.equal(result.canonical.declaredUnits, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── a declared path escaping the root is dropped + diagnosed ───────

test("canonicalAdapter drops a unit whose declared path escapes the root", () => {
  const root = mkTempDir();
  try {
    writeCanonical(root, {
      units: [
        { name: "ok", path: "ok" },
        { name: "evil", path: "../../../../etc" },
      ],
    });
    const result = canonicalAdapter(root, STUB_CTX);

    assert.deepEqual(
      result.partialUnits.map((u) => u.name),
      ["ok"],
      "escaping unit must be dropped, in-root unit kept",
    );
    assert.ok(
      result.diagnostics.some((d) => d.code === "UNIT_PATH_ESCAPE"),
      "expected a UNIT_PATH_ESCAPE diagnostic for the escaping path",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── declared ref is carried through; ref-less units leave ref undefined ────

test("canonicalAdapter carries a declared ref through and leaves ref-less units unset", () => {
  const root = mkTempDir();
  try {
    writeCanonical(root, {
      units: [
        { name: "pinned", path: "pinned", ref: "release/1.x" },
        { name: "floating", path: "floating" },
      ],
    });
    const result = canonicalAdapter(root, STUB_CTX);

    const pinned = result.partialUnits.find((u) => u.name === "pinned");
    const floating = result.partialUnits.find((u) => u.name === "floating");
    assert.equal(pinned.ref, "release/1.x", "declared ref carried through");
    assert.equal(
      Object.hasOwn(floating, "ref"),
      false,
      "ref-less unit leaves ref undefined for map()'s probe loop",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
