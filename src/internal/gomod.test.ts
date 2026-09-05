import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGoMod, parseGoWork } from "./gomod.ts";

test("go.mod: module path, single and block require lines, comments ignored", () => {
  const text = [
    "module example.com/acme/api // the api",
    "",
    "go 1.24",
    "",
    "require example.com/acme/core v0.1.0",
    "require (",
    "\tgithub.com/lib/pq v1.10.9",
    "\tgolang.org/x/text v0.14.0 // indirect",
    ")",
    "replace example.com/acme/core => ../core",
  ].join("\n");
  assert.deepEqual(parseGoMod(text), {
    ok: true,
    module: "example.com/acme/api",
    requires: [
      "example.com/acme/core",
      "github.com/lib/pq",
      "golang.org/x/text",
    ],
  });
  assert.deepEqual(parseGoMod('module "quoted/path"\n'), {
    ok: true,
    module: "quoted/path",
    requires: [],
  });
});

test("go.work: use lines and blocks; the root itself is not a member", () => {
  assert.deepEqual(
    parseGoWork("go 1.24\n\nuse ./api\nuse (\n\t.\n\t./core/\n)\n"),
    {
      ok: true,
      uses: ["api", "core"],
    },
  );
});

test("broken directives are errors with a line number", () => {
  assert.deepEqual(parseGoMod("require (\n\ta v1\n"), {
    ok: false,
    reason: 'line 1: unclosed "require ("',
  });
  assert.deepEqual(parseGoMod("module\n"), {
    ok: false,
    reason: "line 1: module needs one path",
  });
  assert.deepEqual(parseGoMod("require a\n"), {
    ok: false,
    reason: "line 1: require needs a path and a version",
  });
  assert.deepEqual(parseGoWork("use\n"), {
    ok: false,
    reason: "line 1: use needs one path",
  });
});
