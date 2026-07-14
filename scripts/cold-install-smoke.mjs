#!/usr/bin/env node
// Cold-install smoke (PUB-02) — tarball-based, NO live registry.
//
// WHY THIS EXISTS:
// `node --test` and the Bun smoke import the *working* `dist/` directly,
// including internal chunks (dist/internal/serialize.mjs, dist/role.mjs)
// that are NOT in the published tarball — the `files` allowlist ships only
// `dist/index.*` + `dist/platform-map.*`. Those local tests pass even if the
// self-contained `dist/index.mjs` bundle leaked an import to an unshipped
// chunk, because the chunk is present on disk. A real consumer `npm install`
// only gets the tarball. This smoke is the ONLY test that catches a
// bundle-leak / FalseCJS / exports-map regression: it `npm pack`s the built
// package, installs the resulting TARBALL into scratch Node-CJS and Bun
// projects, and asserts the public surface resolves BY PACKAGE NAME
// (`@spec-engine/platform-map`), never a relative dist/ path.
//
// Zero-dep, Node built-ins only — matches the package ethos. Exits non-zero
// on any failed assertion; exits 0 on full pass. All temp dirs + the tarball
// are removed in a `finally`.

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_NAME = "@spec-engine/platform-map";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
// A tiny real tree to point detect()/map() at from inside the scratch
// projects — passed as an ABSOLUTE path so cwd (the scratch dir) is irrelevant.
const fixture = path.join(repoRoot, "test", "fixtures", "single-repo");

const cleanup = [];
function track(p) {
  cleanup.push(p);
  return p;
}
function fail(msg) {
  console.error(`\n✖ cold-install smoke FAILED: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
function log(msg) {
  console.log(`  ${msg}`);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: repoRoot,
    ...opts,
  });
  if (res.error) fail(`${cmd} ${args.join(" ")} — ${res.error.message}`);
  if (res.status !== 0) {
    fail(
      `${cmd} ${args.join(" ")} exited ${res.status}\n${res.stdout || ""}${res.stderr || ""}`,
    );
  }
  return res;
}

try {
  // ── 1. Build (idempotent — the npm script also builds; keeps the raw
  //       `node scripts/cold-install-smoke.mjs` invocation self-sufficient). ──
  log("building…");
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });

  // ── 2. Pack the built package into a temp dir; parse the tarball name from
  //       npm's --json stdout IN-PROCESS (no jq). ──────────────────────────
  const packDir = track(fs.mkdtempSync(path.join(os.tmpdir(), "pm-pack-")));
  log(`packing into ${packDir}…`);
  const packOut = run("npm", [
    "pack",
    "--pack-destination",
    packDir,
    "--json",
  ]).stdout;
  let tarballName;
  try {
    tarballName = JSON.parse(packOut)[0].filename;
  } catch {
    fail(`could not parse 'npm pack --json' output:\n${packOut}`);
  }
  // npm >=9 sometimes reports the scoped name with the scope dir prefix in
  // .filename; the actual file on disk is the basename.
  const tarball = path.join(packDir, path.basename(tarballName));
  track(tarball);
  if (!fs.existsSync(tarball)) fail(`tarball not found at ${tarball}`);
  log(`packed ${path.basename(tarball)}`);

  // ── 3. NODE-CJS scratch project: install the TARBALL, require by NAME. ────
  const cjsDir = track(fs.mkdtempSync(path.join(os.tmpdir(), "pm-cjs-")));
  fs.writeFileSync(
    path.join(cjsDir, "package.json"),
    JSON.stringify({ name: "pm-cjs-scratch", private: true, type: "commonjs" }),
  );
  log("installing tarball into scratch Node-CJS project…");
  run("npm", ["i", tarball, "--no-save", "--no-package-lock"], { cwd: cjsDir });
  const cjsProbe = [
    `const assert = require("node:assert/strict");`,
    `const m = require(${JSON.stringify(PKG_NAME)});`,
    `for (const k of ["map","detect","graph","deriveRole","toJSON","serialize"]) {`,
    `  assert(typeof m[k] === "function", "missing export: " + k);`,
    `}`,
    `const d = m.detect(${JSON.stringify(fixture)});`,
    `assert(d.mode, "detect().mode should be truthy");`,
    `console.log("cjs-require OK — mode=" + d.mode);`,
  ].join("\n");
  const cjsRes = run("node", ["-e", cjsProbe], { cwd: cjsDir });
  log(cjsRes.stdout.trim());

  // ── 4. BUN scratch project: install the TARBALL, import by NAME. ──────────
  //     Guard the Bun lane: a missing `bun` binary must fail LOUDLY.
  const bunProbeAvail = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (bunProbeAvail.error || bunProbeAvail.status !== 0) {
    fail(
      "bun binary not found — the Bun cold-install lane cannot run. " +
        "Install Bun (https://bun.sh) or run this in a CI job with oven-sh/setup-bun.",
    );
  }
  const bunDir = track(fs.mkdtempSync(path.join(os.tmpdir(), "pm-bun-")));
  fs.writeFileSync(
    path.join(bunDir, "package.json"),
    JSON.stringify({ name: "pm-bun-scratch", private: true, type: "module" }),
  );
  log("installing tarball into scratch Bun project (bun add <tarball>)…");
  run("bun", ["add", tarball], { cwd: bunDir });
  const bunProbe = [
    `import * as m from ${JSON.stringify(PKG_NAME)};`,
    `if (typeof m.map !== "function") { console.error("m.map is not a function"); process.exit(1); }`,
    `const pm = await m.map(${JSON.stringify(fixture)});`,
    `if (pm.schemaVersion !== 1) { console.error("schemaVersion !== 1: " + pm.schemaVersion); process.exit(1); }`,
    `console.log("bun-import OK — schemaVersion=" + pm.schemaVersion);`,
  ].join("\n");
  const bunRes = run("bun", ["-e", bunProbe], { cwd: bunDir });
  log(bunRes.stdout.trim());

  // ── 5. CLI check: run the INSTALLED `platform-map --json` bin from the
  //       scratch project's node_modules/.bin — proves the shebang + chmod +x
  //       + self-contained CLI bundle survive packing. ────────────────────
  const binName = process.platform === "win32" ? "platform-map.cmd" : "platform-map";
  const binPath = path.join(cjsDir, "node_modules", ".bin", binName);
  if (!fs.existsSync(binPath)) fail(`installed bin not found at ${binPath}`);
  log("running installed `platform-map --json` bin…");
  const cliRes = run(binPath, ["--json", fixture], { cwd: cjsDir });
  try {
    const parsed = JSON.parse(cliRes.stdout);
    if (!parsed || typeof parsed !== "object") {
      fail("CLI --json output did not parse to an object");
    }
  } catch {
    fail(`CLI --json output is not valid JSON:\n${cliRes.stdout}`);
  }
  log("cli --json OK — valid JSON, exit 0");

  console.log(
    "\n✔ cold-install smoke PASSED — packed tarball cold-installs in Node-CJS + Bun, " +
      "public exports resolve by name, and the CLI bin works. (no live registry)",
  );
} finally {
  for (const p of cleanup) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
