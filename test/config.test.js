// CFG-02/SEC-01: readCanonicalConfig — the hand-rolled zero-dep canonical
// validator and its three DISTINCT location-tagged throws (read / parse /
// validate). This is the SECOND (and final) hard-error path in the whole
// library; adapter sources never throw (that asymmetry is asserted at the
// map() level in map.test.js). Plain ESM .js importing the already-built dist/
// (D-06) — runs unmodified under `node --test` and `bun test` (D-05).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { readCanonicalConfig } from "../dist/config.mjs";

// NOTE: readCanonicalConfig ships in the internal `dist/config.mjs` test-build
// seam, which bundles its OWN copy of the MalformedConfigError class — so a
// cross-bundle `instanceof` against the public `dist/index.mjs` copy would be a
// false negative. This white-box unit test therefore asserts on `err.name`
// (stable across bundles). The PUBLIC same-bundle `instanceof` contract — what
// consumers actually catch off `map()` — is proven in map.test.js, where both
// `map` and `MalformedConfigError` come from `dist/index.mjs`.
function isMalformedConfigError(err) {
  return err instanceof Error && err.name === "MalformedConfigError";
}

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-config-"));
}
function rmTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function writeConfig(dir, contents) {
  fs.writeFileSync(
    path.join(dir, "platform-map.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
}

// ── absent = fine (D8): no throw, returns null ─────────────────────────────

test("absent platform-map.json returns null (no throw)", () => {
  const root = mkTempDir();
  try {
    assert.equal(readCanonicalConfig(root), null);
  } finally {
    rmTempDir(root);
  }
});

// ── stage 1: unreadable (present but read fails) → "could not be read" ──────

test("unreadable platform-map.json throws MalformedConfigError (could not be read)", () => {
  const root = mkTempDir();
  try {
    // A directory at the config path exists but cannot be read as a file
    // (EISDIR) — distinguishes stage-1 read failure from stage-2 parse failure.
    fs.mkdirSync(path.join(root, "platform-map.json"));
    assert.throws(
      () => readCanonicalConfig(root),
      (err) => {
        assert.ok(isMalformedConfigError(err));
        assert.match(err.message, /could not be read/);
        assert.ok(!err.message.includes(root), "no absolute path in message");
        return true;
      },
    );
  } finally {
    rmTempDir(root);
  }
});

// ── stage 2: invalid JSON → "failed to parse as JSON" ──────────────────────

test("invalid JSON throws MalformedConfigError (failed to parse as JSON)", () => {
  const root = mkTempDir();
  try {
    writeConfig(root, "{ not valid json ]");
    assert.throws(
      () => readCanonicalConfig(root),
      (err) => {
        assert.ok(isMalformedConfigError(err));
        assert.match(err.message, /failed to parse as JSON/);
        assert.ok(!err.message.includes(root), "no absolute path in message");
        return true;
      },
    );
  } finally {
    rmTempDir(root);
  }
});

// ── stage 3: valid JSON, wrong shape → "failed validation" ─────────────────

test("units not an array throws MalformedConfigError (failed validation)", () => {
  const root = mkTempDir();
  try {
    writeConfig(root, { units: "nope" });
    assert.throws(
      () => readCanonicalConfig(root),
      (err) => {
        assert.ok(isMalformedConfigError(err));
        assert.match(err.message, /failed validation/);
        return true;
      },
    );
  } finally {
    rmTempDir(root);
  }
});

test("a unit missing name/path throws failed validation", () => {
  const root = mkTempDir();
  try {
    writeConfig(root, { units: [{ path: "svc-a" }] });
    assert.throws(() => readCanonicalConfig(root), isMalformedConfigError);
  } finally {
    rmTempDir(root);
  }
});

test("ignore not a string[] throws failed validation", () => {
  const root = mkTempDir();
  try {
    writeConfig(root, { ignore: [1, 2, 3] });
    assert.throws(() => readCanonicalConfig(root), isMalformedConfigError);
  } finally {
    rmTempDir(root);
  }
});

test("overrides value not an object throws failed validation", () => {
  const root = mkTempDir();
  try {
    writeConfig(root, { overrides: { "svc-a": "library" } });
    assert.throws(() => readCanonicalConfig(root), isMalformedConfigError);
  } finally {
    rmTempDir(root);
  }
});

test("a top-level array (not object) throws failed validation", () => {
  const root = mkTempDir();
  try {
    writeConfig(root, "[]");
    assert.throws(() => readCanonicalConfig(root), isMalformedConfigError);
  } finally {
    rmTempDir(root);
  }
});

// ── forward-compat: unknown top-level key accepted, known keys strict ──────

test("unknown top-level key is ignored (forward-compat), known keys returned", () => {
  const root = mkTempDir();
  try {
    writeConfig(root, {
      name: "acme",
      futureKey: { anything: true },
      units: [{ name: "svc-a", path: "svc-a", ref: "origin/main" }],
      ignore: ["dist"],
      overrides: { "svc-a": { role: "library" } },
    });
    const cfg = readCanonicalConfig(root);
    assert.ok(cfg);
    assert.equal(cfg.name, "acme");
    assert.deepEqual(cfg.units, [
      { name: "svc-a", path: "svc-a", ref: "origin/main" },
    ]);
    assert.deepEqual(cfg.ignore, ["dist"]);
    assert.deepEqual(cfg.overrides, { "svc-a": { role: "library" } });
    // The unknown key must NOT survive onto the sanitized config.
    assert.equal(Object.hasOwn(cfg, "futureKey"), false);
  } finally {
    rmTempDir(root);
  }
});

// ── prototype-pollution guard: a __proto__ override key never pollutes ──────

test("a __proto__ override key does not pollute Object.prototype", () => {
  const root = mkTempDir();
  try {
    writeConfig(root, '{ "overrides": { "__proto__": { "role": "app" } } }');
    // Either it validates+sanitizes (dropping the dangerous key) or it throws;
    // in NO case may Object.prototype be polluted.
    try {
      readCanonicalConfig(root);
    } catch {
      /* throwing is acceptable */
    }
    assert.equal({}.role, undefined, "Object.prototype must not be polluted");
  } finally {
    rmTempDir(root);
  }
});

// ── empty valid config returns an object (config optional forever) ─────────

test("an empty {} config is valid and returns an object", () => {
  const root = mkTempDir();
  try {
    writeConfig(root, {});
    const cfg = readCanonicalConfig(root);
    assert.ok(cfg && typeof cfg === "object");
    assert.equal(cfg.units, undefined);
  } finally {
    rmTempDir(root);
  }
});
