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
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { map, toJSON } from "../dist/index.mjs";

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

// ── RED-108: SE-platform fixture maps through the CLI ───────────────────────

test("--json on an SE-platform fixture emits member units, exit 0 (RED-108)", () => {
  const r = run(["--json", path.join(fixturesDir, "se-platform")]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.mode, "multi-repo");
  const names = parsed.units.map((u) => u.name);
  assert.ok(names.includes("admin"));
  assert.ok(names.includes("expandable/packages/cli"));
  assert.ok(!names.includes("spec-engine"));
  assert.ok(!names.includes("docs"));
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

// ── CR-01: piped stdout must not truncate — full --json JSON round-trips ─────
// spawnSync pipes stdout (not a TTY), the exact async+buffered mode where a
// premature process.exit() would discard the buffered tail past the ~64KB pipe
// buffer. Assert the captured stdout parses as COMPLETE JSON with the expected
// top-level keys and exit code 0 — proving the payload drained before exit.

test("--json piped stdout is complete valid JSON (no process.exit truncation)", async () => {
  const r = run(["--json", MONOREPO_PNPM]);
  assert.equal(r.status, 0, `expected exit 0, stderr: ${r.stderr}`);
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(r.stdout);
  }, "piped --json stdout must be complete, parseable JSON (not truncated)");
  for (const key of [
    "name",
    "root",
    "mode",
    "units",
    "edges",
    "diagnostics",
    "schemaVersion",
  ]) {
    assert.ok(
      Object.hasOwn(parsed, key),
      `complete PlatformMap JSON carries top-level key ${key}`,
    );
  }
  // The captured bytes are exactly toJSON(pm) + "\n" — determinism preserved
  // end-to-end and the full payload drained before the process exited.
  const expected = `${toJSON(await map(MONOREPO_PNPM))}\n`;
  assert.equal(
    r.stdout,
    expected,
    "piped stdout === toJSON(map(dir)) + newline",
  );
});

// ── WR-01: last-resort net for truly unexpected errors ──────────────────────
// The library only throws RootNotFoundError/MalformedConfigError (both mapped to
// a clean exit 1 inside main()); every other error re-throws and, without a
// rejection handler, would become a runtime-dependent unhandled rejection (Node
// vs Bun, both required per D5). Deterministic trigger: `init --yes` targeting a
// FILE path — the single writeFileSync then throws ENOTDIR (an unmapped error).
// The top-level .catch must map it to exit 1 with ONE clean "internal error:"
// line on stderr and NO raw stack-trace frames.

test("unexpected error (ENOTDIR via init on a file) → exit 1, clean one-line stderr, no stack", () => {
  const tmpFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-wr01-")),
    "not-a-dir",
  );
  fs.writeFileSync(tmpFile, "i am a file, not a directory\n");
  try {
    const r = run(["init", "--yes", tmpFile]);
    assert.equal(r.status, 1, `expected exit 1, stderr: ${r.stderr}`);
    assert.match(
      r.stderr,
      /platform-map: internal error:/,
      "last-resort net writes the clean internal-error prefix",
    );
    // One clean line — no raw Node stack-trace frames leaked to the user.
    assert.doesNotMatch(
      r.stderr,
      /\n\s+at\s/,
      "no raw stack-trace frames on stderr",
    );
  } finally {
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  }
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

// ── CLI-04: `init` — the single writer, round-trip + all three refuse gates ──
// Seed a clean single-repo into a temp dir (never mutate the committed fixture),
// then exercise the write, the round-trip through map(), and the refuse gates.

function seedSingleRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-init-"));
  fs.cpSync(SINGLE_REPO, tmp, { recursive: true });
  return tmp;
}

test("init --yes: writes platform-map.json, exit 0, and the file round-trips through map()", async () => {
  const tmp = seedSingleRepo();
  try {
    const r = run(["init", "--yes", tmp]);
    assert.equal(r.status, 0, `expected exit 0, stderr: ${r.stderr}`);
    const configPath = path.join(tmp, "platform-map.json");
    assert.ok(fs.existsSync(configPath), "platform-map.json was written");
    // round-trip: the fresh config validates via map() (no MalformedConfigError)
    // and reflects the proposed name (basename of the temp dir).
    let pm;
    await assert.doesNotReject(async () => {
      pm = await map(tmp);
    });
    assert.equal(pm.name, path.basename(tmp), "written name round-trips");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("init --yes on an already-written dir: exit 1, refuses to clobber, file unchanged", () => {
  const tmp = seedSingleRepo();
  try {
    const first = run(["init", "--yes", tmp]);
    assert.equal(first.status, 0);
    const configPath = path.join(tmp, "platform-map.json");
    const before = fs.readFileSync(configPath, "utf8");
    const second = run(["init", "--yes", tmp]);
    assert.equal(second.status, 1, "refuse-existing → exit 1");
    assert.match(second.stderr, /already exists|refus/);
    assert.equal(
      fs.readFileSync(configPath, "utf8"),
      before,
      "original file unchanged",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── CLI-07 (WR-03): POSIX -- reaches a dir named like a subcommand; a
// subcommand token after the dir is a usage error, never a command reorder ──

test("--json -- detect: maps the child dir literally named detect (map shape, not detect())", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-cli07-"));
  try {
    const child = path.join(tmp, "detect");
    fs.mkdirSync(child);
    fs.writeFileSync(
      path.join(child, "package.json"),
      `${JSON.stringify({ name: "detect", version: "0.0.0" })}\n`,
    );
    const r = run(["--json", "--", "detect"], { cwd: tmp });
    assert.equal(r.status, 0, `expected exit 0, stderr: ${r.stderr}`);
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(r.stdout);
    });
    assert.equal(parsed.name, "detect", "the dir named detect is the root");
    assert.ok(
      Object.hasOwn(parsed, "units"),
      "map() output carries units (detect() JSON has no units key)",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("subcommand token after the dir positional → exit 1, usage error on stderr, empty stdout", () => {
  const r = run(["somedir", "graph"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unexpected argument: graph/);
  assert.match(r.stderr, /usage:/);
  assert.equal(r.stdout, "");
});

test("init without --yes in a non-TTY (spawned): exit 1, /--yes/ on stderr, writes nothing, no hang", () => {
  const tmp = seedSingleRepo();
  try {
    // spawnSync gives the child no controlling TTY → stdin.isTTY is undefined,
    // so this naturally exercises the non-interactive gate (must not hang).
    const r = run(["init", tmp]);
    assert.equal(r.status, 1, "non-TTY without --yes → exit 1");
    assert.match(r.stderr, /--yes/, "tells the user to pass --yes");
    assert.equal(
      fs.existsSync(path.join(tmp, "platform-map.json")),
      false,
      "nothing written when the write is refused",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
