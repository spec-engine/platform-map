// RED-100 rot-proof: the human-runnable demo (scripts/demo-platform.mjs) is
// pinned to reality — if the library's behavior changes, this test goes red
// before a human ever sees a stale demo. Spawns the demo as a real subprocess
// (which itself spawns ~12 built-CLI runs) and asserts exit 0 plus the key
// proof lines on stdout. Plain ESM .js over dist/ (D-06); runs under
// `node --test` and `bun test` (D-05).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "dist", "platform-map.mjs");
const DEMO = path.join(here, "..", "scripts", "demo-platform.mjs");

test("demo script: exit 0 and every proof line present (RED-100)", {
  timeout: 120_000,
}, () => {
  // Fail clearly (not obscurely mid-demo) if the built CLI is missing.
  assert.ok(
    fs.existsSync(CLI),
    `built CLI not found at ${CLI} — run \`npm run build\` before \`npm test\``,
  );
  const r = spawnSync(process.execPath, [DEMO], {
    encoding: "utf8",
    timeout: 110_000,
  });
  assert.equal(
    r.status,
    0,
    `demo must exit 0; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
  );

  // PMAP-010: from-inside vs at-root byte-identity was actually compared.
  assert.match(r.stdout, /PMAP-010 equivalence: BYTE-IDENTICAL/);

  // D-02/IP-6: the local-override byte-comparison matched.
  assert.match(
    r.stdout,
    /Local override: MATCH — byte-identical with and without platform-map\.local\.json/,
  );

  // Scenario 3 (acme platform): the unlisted .git child surfaced honestly —
  // UNCONFIGURED_SIBLING appears in THAT scenario's diagnostics summary line.
  assert.match(
    r.stdout,
    /name=acme mode=multi-repo .*diagnostics=\[[^\]]*UNCONFIGURED_SIBLING[^\]]*\]/,
    "scenario 3 summary line carries UNCONFIGURED_SIBLING",
  );

  // Scenario 4 (drift): the wrong-platform marker surfaced — PLATFORM_DRIFT
  // appears in THAT scenario's diagnostics summary line.
  assert.match(
    r.stdout,
    /name=driftco mode=multi-repo .*diagnostics=\[[^\]]*PLATFORM_DRIFT[^\]]*\]/,
    "scenario 4 summary line carries PLATFORM_DRIFT",
  );

  // No check may have failed silently.
  assert.doesNotMatch(r.stdout, /\n\s*FAIL\s/, "no FAIL lines in the demo");
});
