import assert from "node:assert/strict";
import { test } from "node:test";
import { get, parseToml, strings } from "./toml-subset.ts";

test("tables, dotted keys, arrays of tables, and every value shape a manifest uses", () => {
  const text = [
    "# a Cargo.toml-shaped document",
    "[package]",
    'name = "acme-core"   # trailing comment',
    "version = '0.1.0'",
    "edition.year = 2021",
    "publish = false",
    'description = """',
    "two",
    'lines"""',
    "",
    "[dependencies]",
    'serde = { version = "1", features = ["derive"] }',
    'acme-util = { path = "../util", package = "util" }',
    "",
    "[dependencies.tokio]",
    'version = "1"',
    "",
    "[[bin]]",
    'name = "a"',
    "[[bin]]",
    'name = "b"',
    "[bin.extra]",
    "x = 1.5",
    "",
    "[workspace]",
    "members = [",
    '  "crates/*",  # libs',
    "  'apps/*',",
    "]",
    "exclude = []",
  ].join("\n");
  const r = parseToml(text);
  assert.ok(r.ok);
  assert.deepEqual(r.value.package, {
    name: "acme-core",
    version: "0.1.0",
    edition: { year: 2021 },
    publish: false,
    description: "two\nlines",
  });
  assert.deepEqual(r.value.dependencies, {
    serde: { version: "1", features: ["derive"] },
    "acme-util": { path: "../util", package: "util" },
    tokio: { version: "1" },
  });
  assert.deepEqual(r.value.bin, [
    { name: "a" },
    { name: "b", extra: { x: 1.5 } },
  ]);
  assert.deepEqual(strings(get(r.value, "workspace", "members")), [
    "crates/*",
    "apps/*",
  ]);
  assert.deepEqual(get(r.value, "workspace", "exclude"), []);
  assert.equal(get(r.value, "nothing", "here"), undefined);
});

test("quoted keys, escapes, and an empty or comment-only document", () => {
  const r = parseToml('[tool."my tool"]\nk = "a\\"b\\u00e9"\n');
  assert.ok(r.ok);
  assert.deepEqual(r.value, { tool: { "my tool": { k: 'a"bé' } } });
  assert.deepEqual(parseToml("# nothing\n\n"), { ok: true, value: {} });
});

test("unsupported and broken shapes are errors with a line number, never guesses", () => {
  for (const [text, reason] of [
    ["date = 1979-05-27", 'line 1: unsupported value "1979-05-27"'],
    ['a = "open', "line 1: unterminated string"],
    ["[t]\na = 1\na = 2", 'line 3: "a" is defined twice'],
    ["a = 1\n[a]", 'line 2: "a" is already a value, not a table'],
    ["x = [1, 2", 'line 1: expected "," or "]"'],
    ["x = 1 y = 2", 'line 1: unexpected "y"'],
    ["[t", 'line 1: expected "]"'],
  ]) {
    const r = parseToml(text ?? "");
    assert.ok(!r.ok, text);
    assert.equal(r.reason, reason);
  }
});
