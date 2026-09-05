import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { rm, tmpDir, write } from "../test/helpers.ts";
import { readPlatformFile, readUserConfig, writeUserConfig } from "./files.ts";

test("platform-map.json is told apart by its keys", () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(readPlatformFile(dir), { kind: "absent" });

    write(path.join(dir, "platform-map.json"), {
      name: "acme",
      members: ["b", "a"],
    });
    assert.deepEqual(readPlatformFile(dir), {
      kind: "platform",
      file: { name: "acme", members: ["a", "b"] },
    });

    write(path.join(dir, "platform-map.json"), {
      platform: "acme",
      member: "a",
    });
    assert.deepEqual(readPlatformFile(dir), {
      kind: "marker",
      marker: { platform: "acme", member: "a" },
    });
  } finally {
    rm(dir);
  }
});

test("invalid shapes are diagnostics with the reason", () => {
  const dir = tmpDir();
  const cases: Array<[unknown, RegExp]> = [
    [{}, /expected either/],
    [{ name: "x" }, /expected either/],
    [{ name: "has space", members: [] }, /"name"/],
    [{ name: "x", members: ["../up"] }, /"members"/],
    [{ name: "x", members: [], ignore: "no" }, /"ignore"/],
    [{ platform: "" }, /"platform"/],
    [{ platform: "x", member: "a/b" }, /"member"/],
    ["not json", /Unexpected|JSON/],
  ];
  try {
    for (const [content, reason] of cases) {
      write(
        path.join(dir, "platform-map.json"),
        typeof content === "string" ? content : JSON.stringify(content),
      );
      const read = readPlatformFile(dir);
      assert.equal(read.kind, "invalid");
      if (read.kind === "invalid") {
        assert.equal(read.diagnostic.code, "MALFORMED_FILE");
        assert.match(read.diagnostic.message, reason);
      }
    }
  } finally {
    rm(dir);
  }
});

test("the user file round-trips and a broken one degrades to a warning", () => {
  const dir = tmpDir();
  const opts = { userConfigPath: path.join(dir, "nested", "platforms.json") };
  try {
    assert.deepEqual(readUserConfig(opts), { config: {} });
    writeUserConfig({ acme: { root: "/a", members: { web: "/w" } } }, opts);
    assert.deepEqual(readUserConfig(opts), {
      config: { acme: { root: "/a", members: { web: "/w" } } },
    });

    write(opts.userConfigPath, { acme: { members: {} } });
    const bad = readUserConfig(opts);
    assert.deepEqual(bad.config, {});
    assert.equal(bad.diagnostic?.severity, "warning");
  } finally {
    rm(dir);
  }
});
