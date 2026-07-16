// RED-97 Task 1 (PMAP-012 unit coverage): the discriminated platform-map.json
// readers (IP-1) and the bounded upward resolver (IP-8) — discrimination
// matrix, definition/marker/local validators, walk semantics, and boundary
// containment (D-02/D-03/D-05/D-06).
//
// Plain ESM .js importing the already-built dist/ (D-06) — runs unmodified
// under `node --test` (D-05). NEVER src/, NEVER .ts.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  readCanonicalConfig,
  readLocalConfig,
  readPlatformFile,
} from "../dist/config.mjs";
import {
  resolvePlatformContext,
  sniffPlatformFile,
} from "../dist/internal/platform-root.mjs";

function mktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-root-"));
}

// dist/config.mjs bundles its OWN copy of the MalformedConfigError class (the
// internal test-build seam), so cross-bundle instanceof fails — the house
// idiom (config.test.js) checks the error name instead.
function isMalformedConfigError(err) {
  return err instanceof Error && err.name === "MalformedConfigError";
}

function writeJson(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));
}

function writePlatformFile(dir, value) {
  writeJson(dir, "platform-map.json", value);
}

// ── Discrimination matrix (IP-1) ─────────────────────────────────────────

test("readPlatformFile: members present -> definition", () => {
  const root = mktree();
  try {
    writePlatformFile(root, {
      name: "plat",
      members: [{ name: "a" }, { name: "b", path: "custom" }],
      ignore: ["scratch"],
    });
    const r = readPlatformFile(root);
    assert.equal(r.kind, "definition");
    assert.equal(r.definition.name, "plat");
    assert.equal(r.definition.members.length, 2);
    assert.equal(r.definition.members[0].name, "a");
    assert.equal(r.definition.members[0].path, undefined);
    assert.equal(r.definition.members[1].path, "custom");
    assert.deepEqual(r.definition.ignore, ["scratch"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readPlatformFile: platform present (no members) -> marker with coexisting config", () => {
  const root = mktree();
  try {
    writePlatformFile(root, { platform: "plat", name: "me", ignore: ["x"] });
    const r = readPlatformFile(root);
    assert.equal(r.kind, "marker");
    assert.equal(r.marker.platform, "plat");
    assert.equal(r.marker.root, ".."); // root defaults to ".."
    // coexisting rung-1/2 keys keep their meaning for standalone fallback
    assert.equal(r.config.name, "me");
    assert.deepEqual(r.config.ignore, ["x"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readPlatformFile: explicit marker root is preserved", () => {
  const root = mktree();
  try {
    writePlatformFile(root, { platform: "plat", root: "../.." });
    const r = readPlatformFile(root);
    assert.equal(r.kind, "marker");
    assert.equal(r.marker.root, "../..");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readPlatformFile: neither members nor platform -> unit-level config", () => {
  const root = mktree();
  try {
    writePlatformFile(root, {
      name: "solo",
      units: [{ name: "u", path: "u" }],
    });
    const r = readPlatformFile(root);
    assert.equal(r.kind, "config");
    assert.equal(r.config.name, "solo");
    assert.deepEqual(r.config.units, [{ name: "u", path: "u" }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readPlatformFile: absent -> kind absent", () => {
  const root = mktree();
  try {
    assert.deepEqual(readPlatformFile(root), { kind: "absent" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readPlatformFile: forbidden key combinations throw distinct reasons", () => {
  const root = mktree();
  try {
    const cases = [
      [{ name: "p", members: [{ name: "a" }], platform: "x" }, /"platform"/],
      [{ name: "p", members: [{ name: "a" }], units: [] }, /"units"/],
      [{ name: "p", members: [{ name: "a" }], root: ".." }, /"root"/],
      [{ name: "p", members: [{ name: "a" }], overrides: {} }, /"overrides"/],
      [{ platform: "x", units: [] }, /"units"/],
    ];
    const messages = [];
    for (const [value, re] of cases) {
      writePlatformFile(root, value);
      assert.throws(
        () => readPlatformFile(root),
        (e) => isMalformedConfigError(e) && re.test(e.message),
      );
      try {
        readPlatformFile(root);
      } catch (e) {
        messages.push(e.message);
      }
    }
    // every forbidden combination carries its own distinct reason string
    assert.equal(new Set(messages).size, messages.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Definition validation (three-stage, location-tagged) ──────────────────

test("definition validation: missing/empty name, empty members, bad member fields", () => {
  const root = mktree();
  try {
    const cases = [
      [{ members: [{ name: "a" }] }, /"name" must be a non-empty string/],
      [
        { name: "", members: [{ name: "a" }] },
        /"name" must be a non-empty string/,
      ],
      [{ name: "p", members: [] }, /"members" must be a non-empty array/],
      [{ name: "p", members: "x" }, /"members" must be a non-empty array/],
      [
        { name: "p", members: [{ name: 42 }] },
        /"members\[0\].name" must be a non-empty string/,
      ],
      [
        { name: "p", members: [{ name: "a", path: 7 }] },
        /"members\[0\].path" must be a non-empty string when present/,
      ],
    ];
    for (const [value, re] of cases) {
      writePlatformFile(root, value);
      assert.throws(
        () => readPlatformFile(root),
        (e) => isMalformedConfigError(e) && re.test(e.message),
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("marker validation: non-string/empty platform rejected", () => {
  const root = mktree();
  try {
    for (const value of [{ platform: 42 }, { platform: "" }]) {
      writePlatformFile(root, value);
      assert.throws(
        () => readPlatformFile(root),
        (e) =>
          isMalformedConfigError(e) &&
          /"platform" must be a non-empty string/.test(e.message),
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── readCanonicalConfig back-compat + definition conversion (D-05 reuse) ──

test("readCanonicalConfig: unit-level config behavior unchanged; definition converts members to units", () => {
  const root = mktree();
  try {
    writePlatformFile(root, { name: "solo", ignore: ["a"] });
    assert.deepEqual(readCanonicalConfig(root), {
      name: "solo",
      ignore: ["a"],
    });

    writePlatformFile(root, {
      name: "plat",
      members: [{ name: "a" }, { name: "b", path: "custom" }],
      ignore: ["scratch"],
    });
    const converted = readCanonicalConfig(root);
    assert.equal(converted.name, "plat");
    // member path defaults to member name (child-dir convention)
    assert.deepEqual(converted.units, [
      { name: "a", path: "a" },
      { name: "b", path: "custom" },
    ]);
    assert.deepEqual(converted.ignore, ["scratch"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Local config (platform-map.local.json, LENIENT — never throws) ────────

test("readLocalConfig: absent -> null; valid locations map parses", () => {
  const root = mktree();
  try {
    assert.equal(readLocalConfig(root), null);
    writeJson(root, "platform-map.local.json", {
      locations: { svc: "../elsewhere/svc" },
    });
    const r = readLocalConfig(root);
    assert.equal(r.ok, true);
    assert.deepEqual(r.config.locations, { svc: "../elsewhere/svc" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readLocalConfig: malformed JSON / wrong shape -> diagnostic result, never a throw", () => {
  const root = mktree();
  try {
    fs.writeFileSync(path.join(root, "platform-map.local.json"), "not json{");
    let r = readLocalConfig(root);
    assert.equal(r.ok, false);
    assert.equal(r.diagnostic.code, "MALFORMED_CONFIG");
    assert.equal(r.diagnostic.severity, "warning");
    assert.ok(r.diagnostic.message.includes("platform-map.local.json"));
    assert.ok(!r.diagnostic.message.includes(root)); // never an absolute path

    writeJson(root, "platform-map.local.json", { locations: [] });
    r = readLocalConfig(root);
    assert.equal(r.ok, false);
    assert.equal(r.diagnostic.code, "MALFORMED_CONFIG");

    writeJson(root, "platform-map.local.json", { locations: { svc: 42 } });
    r = readLocalConfig(root);
    assert.equal(r.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readLocalConfig: __proto__/constructor/prototype location keys are skipped", () => {
  const root = mktree();
  try {
    fs.writeFileSync(
      path.join(root, "platform-map.local.json"),
      `{"locations":{"__proto__":"x","constructor":"y","prototype":"z","ok":"p"}}`,
    );
    const r = readLocalConfig(root);
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.config.locations), ["ok"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── sniffPlatformFile (lenient classification) ─────────────────────────────

test("sniffPlatformFile: classifies without throwing, including malformed", () => {
  const root = mktree();
  try {
    assert.equal(sniffPlatformFile(root).kind, "absent");

    writePlatformFile(root, { name: "solo" });
    assert.equal(sniffPlatformFile(root).kind, "config");

    writePlatformFile(root, { platform: "plat" });
    const marker = sniffPlatformFile(root);
    assert.equal(marker.kind, "marker");
    assert.equal(marker.marker.root, "..");

    writePlatformFile(root, { name: "plat", members: [{ name: "a" }] });
    const def = sniffPlatformFile(root);
    assert.equal(def.kind, "definition");
    assert.equal(def.definition.name, "plat");

    fs.writeFileSync(path.join(root, "platform-map.json"), "{{nope");
    const bad = sniffPlatformFile(root);
    assert.equal(bad.kind, "malformed");
    assert.equal(typeof bad.reason, "string");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── The bounded upward walk (IP-8, D-05/D-06) ─────────────────────────────

test("walk: definition at the start dir -> root = start", () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    writePlatformFile(plat, { name: "plat", members: [{ name: "a" }] });
    const ctx = resolvePlatformContext(plat, parent);
    assert.equal(ctx.root, plat);
    assert.equal(ctx.viaMarker, false);
    assert.equal(ctx.definition.name, "plat");
    assert.deepEqual(ctx.diagnostics, []);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("walk: marker at start with healthy parent definition -> root = parent", () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    const member = path.join(plat, "member");
    writePlatformFile(plat, { name: "plat", members: [{ name: "member" }] });
    writePlatformFile(member, { platform: "plat" });
    const ctx = resolvePlatformContext(member, parent);
    assert.equal(ctx.root, plat);
    assert.equal(ctx.viaMarker, true);
    assert.equal(ctx.memberDir, member);
    assert.deepEqual(ctx.diagnostics, []);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("walk: marker + definition found from a nested subdir -> same root", () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    const member = path.join(plat, "member");
    const nested = path.join(member, "packages", "core");
    writePlatformFile(plat, { name: "plat", members: [{ name: "member" }] });
    writePlatformFile(member, { platform: "plat" });
    fs.mkdirSync(nested, { recursive: true });
    const ctx = resolvePlatformContext(nested, parent);
    assert.equal(ctx.root, plat);
    assert.equal(ctx.viaMarker, true);
    assert.deepEqual(ctx.diagnostics, []);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("walk: unit-level config at start or at an ancestor stops with no platform context", () => {
  const parent = mktree();
  try {
    // at start: a rung-1/2 repo explicitly self-describes (back-compat firewall)
    const solo = path.join(parent, "solo");
    writePlatformFile(solo, { name: "solo" });
    let ctx = resolvePlatformContext(solo, parent);
    assert.equal(ctx.root, null);
    assert.deepEqual(ctx.diagnostics, []);

    // at an ancestor: same stop, even with a definition further up
    const holder = path.join(parent, "holder");
    writePlatformFile(parent, { name: "plat", members: [{ name: "holder" }] });
    writePlatformFile(holder, { name: "self-described" });
    const sub = path.join(holder, "sub");
    fs.mkdirSync(sub, { recursive: true });
    ctx = resolvePlatformContext(sub, parent);
    assert.equal(ctx.root, null);
    assert.deepEqual(ctx.diagnostics, []);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("walk: malformed ancestor file -> root null + MALFORMED_CONFIG warning with relative locus", () => {
  const parent = mktree();
  try {
    const broken = path.join(parent, "broken");
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, "platform-map.json"), "{{nope");
    const sub = path.join(broken, "sub");
    fs.mkdirSync(sub, { recursive: true });
    const ctx = resolvePlatformContext(sub, parent);
    assert.equal(ctx.root, null);
    assert.equal(ctx.diagnostics.length, 1);
    const d = ctx.diagnostics[0];
    assert.equal(d.code, "MALFORMED_CONFIG");
    assert.equal(d.severity, "warning");
    assert.equal(d.path, "../platform-map.json"); // relative to startDir, never absolute
    assert.ok(!d.message.includes(parent));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("walk: malformed file at the start dir itself -> root null, NO diagnostic (strict read owns it)", () => {
  const parent = mktree();
  try {
    const bad = path.join(parent, "bad");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "platform-map.json"), "{{nope");
    const ctx = resolvePlatformContext(bad, parent);
    assert.equal(ctx.root, null);
    assert.deepEqual(ctx.diagnostics, []);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("walk: nothing anywhere -> root null", () => {
  const parent = mktree();
  try {
    const sub = path.join(parent, "a", "b");
    fs.mkdirSync(sub, { recursive: true });
    const ctx = resolvePlatformContext(sub, parent);
    assert.equal(ctx.root, null);
    assert.equal(ctx.viaMarker, false);
    assert.deepEqual(ctx.diagnostics, []);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// ── Containment (D-06 / PMAP-012) ──────────────────────────────────────────

test("containment: start dir outside the boundary -> inert", () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    const other = path.join(parent, "other");
    writePlatformFile(plat, { name: "plat", members: [{ name: "a" }] });
    fs.mkdirSync(other, { recursive: true });
    const ctx = resolvePlatformContext(other, plat);
    assert.equal(ctx.root, null);
    assert.deepEqual(ctx.diagnostics, []);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("containment: marker root hint resolving outside the boundary -> UNIT_PATH_ESCAPE, never followed", () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    const member = path.join(plat, "member");
    // a definition exists at the hint target, but the hint escapes the boundary
    writePlatformFile(parent, { name: "outer", members: [{ name: "plat" }] });
    writePlatformFile(member, { platform: "outer", root: "../.." });
    const ctx = resolvePlatformContext(member, plat);
    assert.equal(ctx.root, null);
    assert.equal(ctx.diagnostics.length, 1);
    const d = ctx.diagnostics[0];
    assert.equal(d.code, "UNIT_PATH_ESCAPE");
    assert.ok(d.message.includes("escapes resolution boundary"));
    assert.ok(!d.message.includes(parent));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("containment: the walk never ascends above the boundary dir", () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    const member = path.join(plat, "member");
    const deep = path.join(member, "deep");
    writePlatformFile(plat, { name: "plat", members: [{ name: "member" }] });
    fs.mkdirSync(deep, { recursive: true });
    // boundary = member: the definition at plat sits ABOVE it and must not be found
    const ctx = resolvePlatformContext(deep, member);
    assert.equal(ctx.root, null);
    assert.deepEqual(ctx.diagnostics, []);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// ── Determinism ────────────────────────────────────────────────────────────

test("determinism: resolver result identical across two invocations on the same tree", () => {
  const parent = mktree();
  try {
    const plat = path.join(parent, "plat");
    const member = path.join(plat, "member");
    writePlatformFile(plat, { name: "plat", members: [{ name: "member" }] });
    writePlatformFile(member, { platform: "plat" });
    const a = resolvePlatformContext(member, parent);
    const b = resolvePlatformContext(member, parent);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.deepEqual(a, b);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
