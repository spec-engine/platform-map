#!/usr/bin/env node
// Human-runnable demo (RED-100) — fixture-CREATING script.
//
// WHY THIS EXISTS:
// The 300+ tests prove platform-map to CI, but nothing lets a HUMAN watch it
// work. Committed fixtures cannot contain `.git` directories (see
// test/fixtures/README.md), so the human-facing artifact must be a script
// that MATERIALIZES every platform shape in a scratch dir, runs the built
// CLI against each one, and prints — with a banner per run — exactly what is
// being proven and which PMAP requirement it proves.
//
// Usage:
//   npm run demo                       # build + run, scratch auto-cleaned
//   node scripts/demo-platform.mjs [target-dir] [--keep] [--verbose]
//     --keep      leave the scratch tree on disk and print its path
//     --verbose   print the full --json blob per scenario (not just summaries)
//     target-dir  build the scenarios there instead of a tmpdir (implies --keep;
//                 a user-supplied dir is never deleted)
//
// Zero-dep, Node built-ins only. No network. Writes ONLY inside the scratch
// dir. Exit 0 only if every CLI run exited as expected AND both byte-identity
// comparisons (PMAP-010 equivalence, local-override) matched.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const CLI = path.join(repoRoot, "dist", "platform-map.mjs");

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const VERBOSE = args.includes("--verbose");
const targetArg = args.find((a) => !a.startsWith("--"));

if (!fs.existsSync(CLI)) {
  console.error(
    `demo: built CLI not found at ${CLI} — run \`npm run build\` first (or use \`npm run demo\`, which builds).`,
  );
  process.exit(1);
}

// ── output + check helpers ───────────────────────────────────────────────────
let failures = 0;
function banner(title, ...lines) {
  console.log(`\n${"═".repeat(72)}\n  ${title}`);
  for (const l of lines) console.log(`  ${l}`);
  console.log("═".repeat(72));
}
function check(ok, label) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
  }
  return ok;
}
function indent(text, pad = "    ") {
  return text
    .trimEnd()
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

/** Spawn the built CLI; assert the expected exit code (default 0). */
function runCli(cliArgs, { cwd, expectStatus = 0 } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...cliArgs], {
    encoding: "utf8",
    cwd,
  });
  const ok = r.status === expectStatus && !r.error;
  check(
    ok,
    `\`platform-map ${cliArgs.map((a) => shortenPath(a)).join(" ")}\` exited ${expectStatus}`,
  );
  if (!ok) {
    console.log(indent(`status=${r.status} error=${r.error ?? ""}`));
    if (r.stderr) console.log(indent(`stderr: ${r.stderr}`));
  }
  return r;
}

/** One-line human summary of a --json payload. */
function summarize(jsonText) {
  const pm = JSON.parse(jsonText);
  const codes = [...new Set(pm.diagnostics.map((d) => d.code))].sort();
  return {
    pm,
    line:
      `name=${pm.name} mode=${pm.mode} units=${pm.units.length} ` +
      `edges=${pm.edges.length} diagnostics=[${codes.join(", ") || "none"}]`,
  };
}

// ── fixture-writing helpers (mirrors test/platform-convention.test.js) ──────
function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`);
}
function gitDir(dir) {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
}
function pnpmMonorepo(dir, scope, { withMarker } = {}) {
  gitDir(dir);
  fs.writeFileSync(
    path.join(dir, "pnpm-workspace.yaml"),
    "packages:\n  - 'packages/*'\n",
  );
  if (withMarker) writeJson(path.join(dir, "platform-map.json"), withMarker);
  writeJson(path.join(dir, "packages", scope.lib, "package.json"), {
    name: `@${scope.ns}/${scope.lib}`,
    private: true,
    exports: { ".": "./index.js" },
  });
  writeJson(path.join(dir, "packages", scope.app, "package.json"), {
    name: `@${scope.ns}/${scope.app}`,
    dependencies: { [`@${scope.ns}/${scope.lib}`]: "workspace:*" },
    scripts: { start: "node ." },
  });
}

// ── scratch dir ──────────────────────────────────────────────────────────────
const userSupplied = Boolean(targetArg);
const scratch = userSupplied
  ? (fs.mkdirSync(path.resolve(targetArg), { recursive: true }),
    path.resolve(targetArg))
  : fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-demo-"));
function shortenPath(s) {
  return typeof s === "string" ? s.replaceAll(scratch, "<scratch>") : s;
}

try {
  console.log(`platform-map demo — scratch dir: ${scratch}`);
  // Each scenario lives under its OWN parent dir: sibling .git repos compose
  // into rung-1/2 maps (DET-02/04), so scenarios sharing one parent would
  // contaminate each other's output and make the demo order-dependent.

  // ═══ Scenario 1: single repo (rung 1) ══════════════════════════════════════
  banner(
    "Scenario 1 — single repo (rung 1)",
    "PROVES: PMAP-011 rung 1 — a lone .git repo maps as mode=single-repo.",
    "The repo itself IS the map: zero sub-units, zero edges. (Role derivation",
    "needs units to carry roles — proven on scenarios 2 and 3.)",
  );
  const s1 = path.join(scratch, "1-single-repo", "lonely-service");
  gitDir(s1);
  writeJson(path.join(s1, "package.json"), {
    name: "lonely-service",
    scripts: { start: "node ." },
  });
  const t1 = runCli([s1]);
  console.log(indent(t1.stdout));
  const j1 = summarize(runCli(["--json", s1]).stdout);
  console.log(`  ${j1.line}`);
  if (VERBOSE) console.log(indent(JSON.stringify(j1.pm, null, 2)));
  check(j1.pm.mode === "single-repo", "mode is single-repo (PMAP-011 rung 1)");
  check(
    j1.pm.units.length === 0 && j1.pm.edges.length === 0,
    "the repo IS the map: no sub-units, no edges",
  );

  // ═══ Scenario 2: pnpm monorepo (rung 2) ════════════════════════════════════
  banner(
    "Scenario 2 — pnpm monorepo (rung 2)",
    "PROVES: PMAP-002 detection flavor + workspace units; PMAP-003 —",
    "workspace-dependency edges (web depends on core); and role derivation —",
    "a start script derives role=app, consumed exports derive role=library.",
  );
  const s2 = path.join(scratch, "2-monorepo", "shop-mono");
  pnpmMonorepo(s2, { ns: "demo", lib: "core", app: "web" });
  const t2 = runCli([s2]);
  console.log(indent(t2.stdout));
  const j2 = summarize(runCli(["--json", s2]).stdout);
  console.log(`  ${j2.line}`);
  if (VERBOSE) console.log(indent(JSON.stringify(j2.pm, null, 2)));
  check(j2.pm.mode === "monorepo", "mode is monorepo (PMAP-002)");
  check(
    j2.pm.edges.some(
      (e) =>
        e.from === "packages/web" &&
        e.to === "packages/core" &&
        e.via === "workspace-dependency",
    ),
    "edge packages/web -> packages/core via workspace-dependency (PMAP-003)",
  );
  const role2 = Object.fromEntries(j2.pm.units.map((u) => [u.name, u.role]));
  check(
    role2["packages/web"] === "app" && role2["packages/core"] === "library",
    "roles derived: packages/web=app (start script), packages/core=library (consumed exports)",
  );

  // ═══ Scenario 3: platform of repos (rung 3) ════════════════════════════════
  banner(
    "Scenario 3 — 'acme' platform: definition + members (rung 3)",
    "PROVES: PMAP-011 rung 3 — a platform-map.json definition assembles",
    "member repos (one plain, one monorepo) into one map; an UNLISTED .git",
    "child is reported honestly as UNCONFIGURED_SIBLING, never invented as a",
    "member; a non-repo child yields an info diagnostic.",
  );
  const s3 = path.join(scratch, "3-acme-platform", "acme");
  buildAcmePlatform(s3, { withConfigs: true });
  const t3 = runCli([s3]);
  console.log(indent(t3.stdout));
  if (t3.stderr.trim())
    console.log(indent(`(stderr diagnostics)\n${t3.stderr}`));
  const rootRun = runCli(["--json", "--boundary", scratch, s3]);
  const j3 = summarize(rootRun.stdout);
  console.log(`  ${j3.line}`);
  if (VERBOSE) console.log(indent(JSON.stringify(j3.pm, null, 2)));
  check(j3.pm.mode === "multi-repo", "definition at root forces rung 3");
  check(
    j3.pm.diagnostics.some((d) => d.code === "UNCONFIGURED_SIBLING") &&
      j3.pm.units.every((u) => u.name !== "scratch-experiment"),
    "unlisted .git child -> UNCONFIGURED_SIBLING diagnostic, NOT a unit",
  );

  console.log(
    "\n  Now the SAME map from INSIDE a nested member subdir " +
      "(web-mono/packages/site), boundary-scoped to the scratch root:",
  );
  const site = path.join(s3, "web-mono", "packages", "site");
  const insideRun = runCli(["--json", "--boundary", scratch, site], {
    cwd: site,
  });
  if (check(
    insideRun.stdout === rootRun.stdout,
    "from-inside stdout is byte-equal to at-root stdout",
  )) {
    console.log("  PMAP-010 equivalence: BYTE-IDENTICAL");
  } else {
    console.log("  PMAP-010 equivalence: FAILED — outputs differ");
  }

  console.log("\n  Graph projection (`graph --dot`) at the platform root:");
  const dot = runCli(["graph", "--dot", s3]);
  console.log(indent(dot.stdout));
  check(dot.stdout.includes(" -> "), "DOT output shows at least one edge");

  // ═══ Scenario 3b: `init` bootstrap (the single writer) ═════════════════════
  banner(
    "Scenario 3b — `init --yes` bootstraps a config-less platform",
    "PROVES: CLI-04 — on a fresh copy of the acme platform WITHOUT any",
    "platform-map.json files, `init --yes` writes the definition + one marker",
    "per .git member, and the result immediately maps as rung 3.",
  );
  const s5 = path.join(scratch, "5-init-bootstrap", "acme-fresh");
  buildAcmePlatform(s5, { withConfigs: false });
  runCli(["init", "--yes", s5]);
  const written = findConfigFiles(s5);
  console.log("  files written by init:");
  for (const f of written) console.log(`    ${path.relative(scratch, f)}`);
  check(
    written.some((f) => path.dirname(f) === s5),
    "root definition platform-map.json written",
  );
  const j5 = summarize(runCli(["--json", "--boundary", scratch, s5]).stdout);
  console.log(`  ${j5.line}`);
  if (VERBOSE) console.log(indent(JSON.stringify(j5.pm, null, 2)));
  check(
    j5.pm.mode === "multi-repo" &&
      ["svc-api", "web-mono"].every((n) =>
        j5.pm.units.some((u) => u.name === n),
      ),
    "freshly-initialized platform maps as rung 3 with its members",
  );

  // ═══ Scenario 4: drift + local override ════════════════════════════════════
  banner(
    "Scenario 4 — marker drift + per-user local override",
    "PROVES: PMAP-012 — a member marker naming the WRONG platform yields a",
    "PLATFORM_DRIFT warning (never silent); and D-02/IP-6 — relocating a",
    "member on disk via platform-map.local.json changes NOTHING in the",
    "output: byte-identical, and the local path never leaks.",
  );
  const s4 = path.join(scratch, "4-drift-and-local");
  const plat4 = path.join(s4, "plat");
  gitDir(plat4);
  writeJson(path.join(plat4, "platform-map.json"), {
    name: "driftco",
    members: [{ name: "svc-drift" }, { name: "svc-good" }],
  });
  const svcGood = path.join(plat4, "svc-good");
  gitDir(svcGood);
  writeJson(path.join(svcGood, "package.json"), {
    name: "svc-good",
    scripts: { start: "node ." },
  });
  writeJson(path.join(svcGood, "platform-map.json"), {
    platform: "driftco",
    root: "..",
  });
  const svcDrift = path.join(plat4, "svc-drift");
  gitDir(svcDrift);
  writeJson(path.join(svcDrift, "package.json"), { name: "svc-drift" });
  writeJson(path.join(svcDrift, "platform-map.json"), {
    platform: "other", // ← WRONG platform name → PLATFORM_DRIFT warning
    root: "..",
  });

  const t4 = runCli([plat4], {});
  console.log(indent(t4.stdout));
  if (t4.stderr.trim())
    console.log(indent(`(stderr diagnostics)\n${t4.stderr}`));
  const beforeLocal = runCli(["--json", "--boundary", s4, plat4]);
  const j4 = summarize(beforeLocal.stdout);
  console.log(`  ${j4.line}`);
  if (VERBOSE) console.log(indent(JSON.stringify(j4.pm, null, 2)));
  check(
    j4.pm.diagnostics.some(
      (d) => d.code === "PLATFORM_DRIFT" && d.severity === "warning",
    ),
    "wrong marker platform-name -> PLATFORM_DRIFT warning (PMAP-012)",
  );

  console.log(
    "\n  Now svc-good is physically MOVED to _relocated/svc-good and a",
  );
  console.log(
    "  platform-map.local.json points at it — the map must not change:",
  );
  fs.mkdirSync(path.join(s4, "_relocated"), { recursive: true });
  fs.renameSync(svcGood, path.join(s4, "_relocated", "svc-good"));
  writeJson(path.join(plat4, "platform-map.local.json"), {
    locations: { "svc-good": "../_relocated/svc-good" },
  });
  const afterLocal = runCli(["--json", "--boundary", s4, plat4]);
  const identical = afterLocal.stdout === beforeLocal.stdout;
  check(identical, "output with local override is byte-identical to before");
  console.log(
    identical
      ? "  Local override: MATCH — byte-identical with and without platform-map.local.json"
      : "  Local override: MISMATCH — outputs differ (this is a bug)",
  );
  check(
    !afterLocal.stdout.includes("_relocated"),
    "the per-user disk location never leaks into the output (IP-6)",
  );

  // ═══ verdict ════════════════════════════════════════════════════════════════
  banner(
    failures === 0
      ? "DEMO PASSED — every shape mapped as specified"
      : `DEMO FAILED — ${failures} check(s) did not hold`,
    failures === 0
      ? "All CLI runs exited as expected; PMAP-010 equivalence and the"
      : "Scroll up for the FAIL lines.",
    failures === 0 ? "local-override comparison were byte-identical." : "",
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  if (KEEP || userSupplied) {
    console.log(`\nscratch tree kept at: ${scratch}`);
  } else {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ── scenario builders ────────────────────────────────────────────────────────

/** The canonical rung-3 platform: plain member + monorepo member + an
 *  unlisted .git child + a non-repo child. `withConfigs: false` builds the
 *  same tree WITHOUT any platform-map.json (the `init` demo's starting
 *  point). */
function buildAcmePlatform(root, { withConfigs }) {
  gitDir(root); // the platform root is itself a small git repo (D-01)
  if (withConfigs) {
    writeJson(path.join(root, "platform-map.json"), {
      name: "acme",
      members: [{ name: "svc-api" }, { name: "web-mono" }],
    });
  }
  const svcApi = path.join(root, "svc-api");
  gitDir(svcApi);
  writeJson(path.join(svcApi, "package.json"), {
    name: "svc-api",
    scripts: { start: "node ." },
  });
  if (withConfigs) {
    writeJson(path.join(svcApi, "platform-map.json"), {
      platform: "acme",
      root: "..",
    });
  }
  pnpmMonorepo(
    path.join(root, "web-mono"),
    { ns: "acme", lib: "ui", app: "site" },
    withConfigs ? { withMarker: { platform: "acme", root: ".." } } : {},
  );
  gitDir(path.join(root, "scratch-experiment")); // unlisted → UNCONFIGURED_SIBLING
  fs.mkdirSync(path.join(root, "docs"), { recursive: true }); // non-repo → info
}

/** All platform-map.json files under a root (sorted, skipping dotdirs). */
function findConfigFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name === "platform-map.json") out.push(p);
    }
  }
  return out.sort();
}
