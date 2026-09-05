import assert from "node:assert/strict";
import { test } from "node:test";
import { patterns as adversarial } from "../../test/fixtures/adversarial-glob/corpus.js";
import { matchGlob } from "./glob.ts";

const paths = [
  "packages/a",
  "packages/b",
  "packages/b/src",
  "apps/web",
  "tools/x/y",
  "README.md",
];

test("literal, *, **, and ! patterns behave like workspace manifests expect", () => {
  assert.deepEqual(matchGlob(["packages/*"], paths).matched, [
    "packages/a",
    "packages/b",
  ]);
  assert.deepEqual(matchGlob(["**/y"], paths).matched, ["tools/x/y"]);
  assert.deepEqual(matchGlob(["packages/**"], paths).matched, [
    "packages/a",
    "packages/b",
    "packages/b/src",
  ]);
  assert.deepEqual(matchGlob(["packages/*", "!packages/b"], paths).matched, [
    "packages/a",
  ]);
  assert.deepEqual(matchGlob(["apps/w*"], paths).matched, ["apps/web"]);
});

test("a pattern that matches nothing is reported; a ! that removes nothing is silent", () => {
  const r = matchGlob(["nothing/*", "!also-nothing"], paths);
  assert.deepEqual(r.matched, []);
  assert.deepEqual(
    r.diagnostics.map((d) => [d.code, d.subject]),
    [["UNMATCHED_PATTERN", "nothing/*"]],
  );
});

test("hostile patterns finish quickly", () => {
  const started = Date.now();
  matchGlob(adversarial, [
    Array(200).fill("x").join("/"),
    `packages/${"a".repeat(300)}b`,
  ]);
  assert.ok(Date.now() - started < 2000);
});
