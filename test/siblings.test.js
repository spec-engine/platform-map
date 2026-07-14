// CFG-07: siblingsAdapter — provisional sibling emit + DF-pointer detection at
// the correct .factory/df-config.json STATE_DIR path. Plain ESM .js importing
// the already-built dist/adapters/siblings.mjs (D-06) — runs unmodified under
// `node --test` and `bun test` (D-05).
//
// The ref probe is deliberately NOT this adapter's job (map() owns it), so the
// resolve-slow-sibling-to-null behavior is asserted at the map() level in
// map.test.js; here we assert the adapter itself never imports/calls probeRef.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { siblingsAdapter } from "../dist/adapters/siblings.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-siblings-"));
}
function rmTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function ctx(siblings, options = {}) {
  return { detection: { mode: "multi-repo", siblings }, ignore: [], options };
}

function sib(name) {
  return { name, path: name, ref: null, hasDfPointer: false, conflict: null };
}

test("siblingsAdapter emits provisional kind:repo units, source:siblings, edges:[], NO ref", async () => {
  const root = mkTempDir();
  try {
    fs.mkdirSync(path.join(root, "svc-a"));
    fs.mkdirSync(path.join(root, "svc-b"));
    const result = await siblingsAdapter(
      root,
      ctx([sib("svc-a"), sib("svc-b")]),
    );
    assert.deepEqual(result.edges, []);
    assert.equal(result.partialUnits.length, 2);
    for (const unit of result.partialUnits) {
      assert.equal(unit.kind, "repo");
      assert.equal(unit.source, "siblings");
      assert.equal(unit.provisional, true);
      assert.equal(unit.ref, undefined, "siblings never declare a ref");
    }
  } finally {
    rmTempDir(root);
  }
});

test("siblingsAdapter detects a pointer-only .factory/df-config.json (hasDfPointer)", async () => {
  const root = mkTempDir();
  try {
    const s = path.join(root, "svc");
    fs.mkdirSync(path.join(s, ".factory"), { recursive: true });
    fs.writeFileSync(
      path.join(s, ".factory", "df-config.json"),
      JSON.stringify({ platform: { factoryDir: ".factory" } }),
    );
    const result = await siblingsAdapter(root, ctx([sib("svc")]));
    const unit = result.partialUnits.find((u) => u.name === "svc");
    assert.equal(unit.signals.hasDfPointer, true);
    assert.equal(Object.hasOwn(unit.signals, "dfConfigConflict"), false);
  } finally {
    rmTempDir(root);
  }
});

test("siblingsAdapter flags a non-pointer .factory/df-config.json (dfConfigConflict)", async () => {
  const root = mkTempDir();
  try {
    const s = path.join(root, "svc");
    fs.mkdirSync(path.join(s, ".factory"), { recursive: true });
    fs.writeFileSync(
      path.join(s, ".factory", "df-config.json"),
      JSON.stringify({ platform: { factoryDir: ".factory" }, repos: ["a"] }),
    );
    const result = await siblingsAdapter(root, ctx([sib("svc")]));
    const unit = result.partialUnits.find((u) => u.name === "svc");
    assert.equal(unit.signals.dfConfigConflict, true);
    assert.equal(Object.hasOwn(unit.signals, "hasDfPointer"), false);
  } finally {
    rmTempDir(root);
  }
});

test("siblingsAdapter treats a malformed df-config.json as a conflict, never throws", async () => {
  const root = mkTempDir();
  try {
    const s = path.join(root, "svc");
    fs.mkdirSync(path.join(s, ".factory"), { recursive: true });
    fs.writeFileSync(
      path.join(s, ".factory", "df-config.json"),
      "{ this is not json",
    );
    let result;
    await assert.doesNotReject(async () => {
      result = await siblingsAdapter(root, ctx([sib("svc")]));
    });
    const unit = result.partialUnits.find((u) => u.name === "svc");
    assert.equal(unit.signals.dfConfigConflict, true);
  } finally {
    rmTempDir(root);
  }
});

test("siblingsAdapter omits both df signals when no .factory/df-config.json exists (MODEL-02 absence-omission)", async () => {
  const root = mkTempDir();
  try {
    fs.mkdirSync(path.join(root, "svc"));
    const result = await siblingsAdapter(root, ctx([sib("svc")]));
    const unit = result.partialUnits.find((u) => u.name === "svc");
    assert.equal(Object.hasOwn(unit.signals, "hasDfPointer"), false);
    assert.equal(Object.hasOwn(unit.signals, "dfConfigConflict"), false);
  } finally {
    rmTempDir(root);
  }
});

test("siblingsAdapter does NOT treat a bare <sibling>/df-config.json (wrong path) as a pointer (Pitfall 6)", async () => {
  const root = mkTempDir();
  try {
    const s = path.join(root, "svc");
    fs.mkdirSync(s);
    // The OLD (buggy) path — must be ignored now that detection is at .factory/.
    fs.writeFileSync(
      path.join(s, "df-config.json"),
      JSON.stringify({ platform: { factoryDir: ".factory" } }),
    );
    const result = await siblingsAdapter(root, ctx([sib("svc")]));
    const unit = result.partialUnits.find((u) => u.name === "svc");
    assert.equal(Object.hasOwn(unit.signals, "hasDfPointer"), false);
    assert.equal(Object.hasOwn(unit.signals, "dfConfigConflict"), false);
  } finally {
    rmTempDir(root);
  }
});

test("siblings.ts neither imports nor calls probeRef — map() owns the ref probe", () => {
  const src = fs.readFileSync(
    path.join(here, "..", "src", "adapters", "siblings.ts"),
    "utf8",
  );
  const nonComment = src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  assert.equal(/probeRef/.test(nonComment), false);
});

test("siblingsAdapter never sorts its own output (serialize.ts is the sole sort site)", () => {
  const src = fs.readFileSync(
    path.join(here, "..", "src", "adapters", "siblings.ts"),
    "utf8",
  );
  const nonComment = src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  assert.equal(nonComment.includes(".sort("), false);
});
