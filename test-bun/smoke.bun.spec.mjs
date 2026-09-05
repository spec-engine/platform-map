// Bun smoke test: the built package works when run by Bun. The main suite
// uses node:test, which Bun's runner cannot run in full, so this file uses
// Bun's own test API against dist/ and lives outside test/ so `node --test`
// does not pick it up.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("bun: map() on a small platform, identical from the root and a member", async () => {
  const { map, toJSON } = await import(path.join(repoRoot, "dist", "index.mjs"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-bun-"));
  try {
    for (const m of ["a", "b"]) {
      fs.mkdirSync(path.join(dir, m, ".git"), { recursive: true });
      fs.writeFileSync(path.join(dir, m, "platform-map.json"), JSON.stringify({ platform: "p", member: m }));
    }
    fs.writeFileSync(path.join(dir, "platform-map.json"), JSON.stringify({ name: "p", members: ["a", "b"] }));
    const pm = map(dir);
    expect(pm.mode).toBe("multi-repo");
    expect(pm.repos.map((r) => r.name)).toEqual(["a", "b"]);
    expect(toJSON(pm)).toBe(toJSON(map(path.join(dir, "a"))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bun: the CommonJS entry loads and exports the same functions", () => {
  const cjs = require(path.join(repoRoot, "dist", "index.cjs"));
  expect(typeof cjs.map).toBe("function");
  expect(typeof cjs.planInit).toBe("function");
});
