// CLI-01/02/05 (black-box): spawn the BUILT dist/platform-map.mjs as a real
// subprocess and assert its stdout/stderr split and exit codes. A genuinely new
// test shape for this repo (no other test invokes the built CLI). Plain ESM .js
// over dist/ (D-06); runs under `node --test` and `bun test` (D-05).
//
// SC2 stream-separation is proven POSITIVELY on a DIAGNOSTIC-PRODUCING fixture
// (monorepo-pnpm emits MALFORMED_CONFIG): stderr CONTAINS the code, stdout does
// NOT. A single-repo fixture emits zero diagnostics and would pass vacuously.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const CLI = path.join(here, "..", "dist", "platform-map.mjs");
const SINGLE_REPO = path.join(fixturesDir, "single-repo");
const MONOREPO_PNPM = path.join(fixturesDir, "monorepo-pnpm");
const MONOREPO_EDGES = path.join(fixturesDir, "monorepo-edges");
const PKG_VERSION = JSON.parse(
  readFileSync(path.join(here, "..", "package.json"), "utf8"),
).version;

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    input: opts.input,
  });
}

// ── CLI-01: human tree → stdout, diagnostics → stderr, nothing leaks ────────

test("default human mode: clean fixture → tree on stdout, exit 0", () => {
  const r = run([SINGLE_REPO]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /single-repo/);
  assert.doesNotMatch(
    r.stdout,
    /CONFIG_CONFLICT|UNMATCHED_PATTERN|UNCONFIGURED_SIBLING|MALFORMED_CONFIG/,
    "SC2: no diagnostic code on stdout",
  );
});

test("default human mode: diagnostic-producing fixture separates streams (SC2)", () => {
  const r = run([MONOREPO_PNPM]);
  assert.equal(r.status, 0);
  // (a) stderr CONTAINS the diagnostic code …
  assert.match(r.stderr, /MALFORMED_CONFIG/, "diagnostic → stderr");
  // (b) … and stdout does NOT.
  assert.doesNotMatch(
    r.stdout,
    /MALFORMED_CONFIG/,
    "SC2: no diag byte on stdout",
  );
  assert.match(r.stdout, /monorepo-pnpm \(monorepo\)/, "tree header on stdout");
});

// ── CLI-02: --json → toJSON on stdout, NOTHING on stderr ────────────────────

test("--json: parses as JSON with schemaVersion 1, stderr empty (SC2 hard)", () => {
  const r = run(["--json", MONOREPO_PNPM]);
  assert.equal(r.status, 0);
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(r.stdout);
  });
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(r.stderr, "", "SC2: --json writes nothing to stderr");
});

// ── CLI-05: exit codes 0/1 (0 covered above; 2 is white-box in cli-render) ──

test("nonexistent root → exit 1, 'root not found' on stderr, empty stdout", () => {
  const r = run([path.join(fixturesDir, "does-not-exist")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /root not found/);
  assert.equal(r.stdout, "");
});

test("bad flag (--nope) → exit 1 (usage error)", () => {
  const r = run(["--nope"]);
  assert.equal(r.status, 1);
});

// ── --version / --help → stdout, exit 0 ─────────────────────────────────────

test("--version → exit 0, prints the package.json version", () => {
  const r = run(["--version"]);
  assert.equal(r.status, 0);
  assert.ok(
    r.stdout.includes(PKG_VERSION),
    `expected stdout to include version ${PKG_VERSION}, got: ${r.stdout}`,
  );
  assert.equal(
    r.stdout.includes("__CLI_VERSION__"),
    false,
    "token substituted",
  );
});

test("--help → exit 0, non-empty, names the init subcommand", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.length > 0);
  assert.match(r.stdout, /init/);
});

// ── CLI-03: `detect` → detect() JSON on stdout, 0-or-throw, no diagnostics ───

test("detect: monorepo fixture → JSON with a mode field on stdout, empty stderr, exit 0", () => {
  const r = run(["detect", MONOREPO_PNPM]);
  assert.equal(r.status, 0);
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(r.stdout);
  });
  assert.ok(
    Object.hasOwn(parsed, "mode"),
    "detect JSON carries a `mode` field",
  );
  assert.equal(r.stderr, "", "detect has no diagnostics → nothing on stderr");
});

test("detect: nonexistent root → exit 1, 'root not found' on stderr", () => {
  const r = run(["detect", path.join(fixturesDir, "does-not-exist")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /root not found/);
});

// ── CLI-03: `graph` → {nodes,edges,roots,leaves,cycles} projection on stdout ─

test("graph: edges fixture → projection JSON with the five keys, non-empty edges", () => {
  const r = run(["graph", MONOREPO_EDGES]);
  assert.equal(r.status, 0);
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(r.stdout);
  });
  for (const key of ["nodes", "edges", "roots", "leaves", "cycles"]) {
    assert.ok(Object.hasOwn(parsed, key), `projection has key ${key}`);
  }
  assert.ok(
    Array.isArray(parsed.edges) && parsed.edges.length > 0,
    "the edges fixture produces a non-empty edge set",
  );
});

// ── CLI-03: `graph --dot` → minimal Graphviz DOT on stdout (not JSON) ────────

test("graph --dot: edges fixture → DOT digraph on stdout, not JSON", () => {
  const r = run(["graph", "--dot", MONOREPO_EDGES]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^digraph platform \{/, "starts with the DOT header");
  assert.match(r.stdout, / -> /, "contains at least one edge arrow");
  assert.throws(() => JSON.parse(r.stdout), "DOT is not JSON");
});
