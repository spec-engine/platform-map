#!/usr/bin/env node
// CLI entry / dispatcher (CLI-01/02/05/06). A thin (~100-line) ESM-only entry:
// parse argv -> one library call -> stream-route -> exit. All pure logic lives
// in src/internal/cli-render.ts; this file owns only the stream writes, the
// single map() call, and the error->exit-1 mapping.
//
// Uses no build-relative path globals (D-04) — resolution is always relative
// to the caller-supplied `dir`, which map() path.resolves internally; the version
// is injected at build time (__CLI_VERSION__), never read from package.json here.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import {
  detect,
  MalformedConfigError,
  map,
  RootNotFoundError,
  toJSON,
} from "../src/index.js";
import {
  buildPlatformInit,
  buildProposal,
  exitFor,
  graphProjection,
  help,
  parseArgs,
  parseYesNo,
  renderTree,
  toDot,
  usage,
} from "../src/internal/cli-render.js";
import type { Detection, MapOptions, PlatformMap } from "../src/types.js";

// Build-time-injected version constant (tsdown `define`); declared so
// `tsc --noEmit` type-checks without a runtime package.json read (D-04).
declare const __CLI_VERSION__: string;

/** WR-03: threads the optional --boundary flag into MapOptions — omitted, the
 *  library default (os.homedir()) applies. */
function mapOptions(boundary: string | undefined): MapOptions {
  return boundary === undefined ? {} : { boundary };
}

/** One diagnostic message per line → stderr (human mode only; --json embeds them). */
function writeDiagnostics(pm: PlatformMap): void {
  for (const d of pm.diagnostics) {
    process.stderr.write(`${d.message}\n`);
  }
}

// Shared confirm gate for init writes (D-07): with `--yes` the write is
// pre-confirmed; a non-TTY stdin without `--yes` refuses (exit 1 — never hang
// a CI job on stdin); a typed `N` declines cleanly (exit 0). Returns null when
// the write is confirmed, else the exit code. The readline prompt and every
// refuse/decline line go to STDERR so stdout stays the proposal/plan.
async function confirmWrite(
  yes: boolean,
  prompt: string,
): Promise<number | null> {
  if (yes) return null;
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "platform-map: non-interactive; pass --yes to write\n",
    );
    return 1;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // prompt → stderr; stdout stays the proposal
  });
  const answer = await rl.question(prompt);
  rl.close();
  if (!parseYesNo(answer)) {
    process.stderr.write("platform-map: aborted\n");
    return 0; // typed N is a clean decline, not an error
  }
  return null;
}

// init platform-bootstrap branch (D-07/RED-97): a manifest-less dir whose
// CHILDREN include .git repos gets the rung-3 proposal — a checked-in
// definition at the root plus one committed marker per member. The root
// refuse-if-exists gate already passed in runInit (root file present refuses
// the WHOLE init); here the per-member gate applies: a member whose
// platform-map.json already exists is excluded from the plan with a stderr
// note and never overwritten — the remaining files are still written. The
// plan prints to STDOUT as one JSON object keyed by root-relative file path;
// the confirmation listing (every path) goes to STDERR. Every write target is
// the FIXED basename platform-map.json under the root or a DETECTED .git
// child dir — the user controls directories, never filenames
// (SEC-05 / V12 / T-04-08 preserved). platform-map.local.json is NEVER
// written and .gitignore is never touched (D-02: the local file is per-user;
// docs cover gitignoring it).
async function runPlatformInit(
  dir: string,
  yes: boolean,
  detection: Detection,
): Promise<number> {
  const name = path.basename(path.resolve(dir));
  const plan = buildPlatformInit(name, detection.siblings ?? []).filter((f) => {
    if (f.path === "platform-map.json") return true; // gated whole-init in runInit
    // WR-05: never write THROUGH a symlinked member dir — the marker would
    // land physically outside the tree the user targeted. lstat (no follow)
    // the immediate parent of the write target; a symlink is skipped with a
    // note. Scoped to the writer only — scan candidacy is unchanged.
    const segments = f.path.split("/");
    const memberDir = path.join(dir, ...segments.slice(0, -1));
    try {
      if (fs.lstatSync(memberDir).isSymbolicLink()) {
        process.stderr.write(
          `platform-map: ${segments.slice(0, -1).join("/")} is a symlink; skipping\n`,
        );
        return false;
      }
    } catch {
      // missing dir: leave it to the write to fail loudly
    }
    if (fs.existsSync(path.join(dir, ...segments))) {
      process.stderr.write(`platform-map: ${f.path} exists; skipping\n`);
      return false;
    }
    return true;
  });
  const planObject: Record<string, unknown> = {};
  for (const f of plan) planObject[f.path] = f.content;
  process.stdout.write(`${JSON.stringify(planObject, null, 2)}\n`);
  process.stderr.write(
    `platform-map: will write ${plan.length} file${plan.length === 1 ? "" : "s"}:\n`,
  );
  for (const f of plan) process.stderr.write(`  ${f.path}\n`);
  const gate = await confirmWrite(
    yes,
    `Write ${plan.length} file${plan.length === 1 ? "" : "s"}? [y/N] `,
  );
  if (gate !== null) return gate;
  for (const f of plan) {
    // WR-04: the plan-time existsSync gate is advisory (a file can appear
    // during the unbounded interactive prompt) — the exclusive "wx" flag
    // makes refuse-if-exists ATOMIC at write time. EEXIST on the root file
    // refuses the whole init (it is written first, so nothing precedes it);
    // EEXIST on a member marker is the per-file skip.
    try {
      fs.writeFileSync(
        path.join(dir, ...f.path.split("/")),
        `${JSON.stringify(f.content, null, 2)}\n`,
        { flag: "wx" },
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        if (f.path === "platform-map.json") {
          process.stderr.write(
            "platform-map: platform-map.json already exists; refusing to overwrite\n",
          );
          return 1;
        }
        process.stderr.write(`platform-map: ${f.path} exists; skipping\n`);
        continue;
      }
      throw e;
    }
    process.stderr.write(`platform-map: wrote ${f.path}\n`);
  }
  return 0;
}

// init — the ONE and ONLY write path in the entire package (SEC-05). Gated three
// ways before any write: refuse-if-exists (never clobber an authored file),
// non-TTY-without-`--yes`, and a typed `N` (both via confirmWrite). The proposal
// prints to STDOUT (machine-consumable); the readline prompt and every
// status/refuse line go to STDERR so stdout stays clean. The write
// target is the FIXED basename path.join(dir, "platform-map.json") — the user
// controls the directory, never the filename (SEC-05 / V12 / T-04-08).
async function runInit(dir: string, yes: boolean): Promise<number> {
  const configPath = path.join(dir, "platform-map.json");
  if (fs.existsSync(configPath)) {
    process.stderr.write(
      "platform-map: platform-map.json already exists; refusing to overwrite\n",
    );
    return 1;
  }
  // detect() may throw RootNotFoundError → caught by main()'s try/catch → exit 1.
  const detection = detect(dir);
  if (detection.mode !== "monorepo") {
    // D-07/RED-97: no workspace manifest — probe the dir's own CHILDREN for
    // .git repos (scanRoot "."). Multi-repo here means "this dir is a
    // platform root": bootstrap the rung-3 definition + member markers. A
    // childless dir falls through to today's parent-sibling/{ name } flow —
    // the manifest branch above stays byte-for-byte unchanged.
    const children = detect(dir, { scanRoot: "." });
    if (children.mode === "multi-repo") {
      return runPlatformInit(dir, yes, children);
    }
  }
  const text = JSON.stringify(
    buildProposal(detection, path.basename(path.resolve(dir))),
    null,
    2,
  );
  process.stdout.write(`${text}\n`);
  const gate = await confirmWrite(yes, "Write platform-map.json? [y/N] ");
  if (gate !== null) return gate;
  // WR-04: exclusive flag — a file created during the prompt window is never
  // clobbered; the early existsSync refusal above stays for pre-prompt UX.
  try {
    fs.writeFileSync(configPath, `${text}\n`, { flag: "wx" }); // the rung-1/2 single write (SEC-05)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      process.stderr.write(
        "platform-map: platform-map.json already exists; refusing to overwrite\n",
      );
      return 1;
    }
    throw e;
  }
  process.stderr.write("platform-map: wrote platform-map.json\n");
  return 0;
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  if (a.error) {
    process.stderr.write(usage(a.error));
    return 1;
  }
  if (a.help) {
    process.stdout.write(help());
    return 0;
  }
  if (a.version) {
    process.stdout.write(`${__CLI_VERSION__}\n`);
    return 0;
  }
  try {
    switch (a.command) {
      case "detect": {
        // detect() is SYNC and carries no diagnostics (0-or-throw): pretty JSON
        // to stdout, nothing to stderr. A bad root throws → caught below → exit 1.
        process.stdout.write(`${JSON.stringify(detect(a.dir), null, 2)}\n`);
        return 0;
      }
      case "graph": {
        // graph ran map() → diagnostics route to stderr and exitFor(pm) sets the
        // code. --dot emits DOT; otherwise the {nodes,edges,roots,leaves,cycles}
        // projection. Both render from serialize(pm)/graph(pm) — the CLI never sorts.
        const pm = await map(a.dir, mapOptions(a.boundary));
        process.stdout.write(
          `${a.dot ? toDot(pm) : JSON.stringify(graphProjection(pm), null, 2)}\n`,
        );
        writeDiagnostics(pm);
        return exitFor(pm);
      }
      case "init": {
        // init: the single writer (SEC-05). All gating lives in runInit.
        return await runInit(a.dir, a.yes);
      }
      default: {
        // default (map) path.
        const pm = await map(a.dir, mapOptions(a.boundary));
        if (a.json) {
          // --json: deterministic toJSON to stdout, NOTHING to stderr (SC2).
          process.stdout.write(`${toJSON(pm)}\n`);
        } else {
          // human: tree to stdout, diagnostics to stderr (SC2).
          process.stdout.write(`${renderTree(pm)}\n`);
          writeDiagnostics(pm);
        }
        return exitFor(pm);
      }
    }
  } catch (e) {
    if (e instanceof RootNotFoundError || e instanceof MalformedConfigError) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    throw e; // truly unexpected — surface it, never mask as 0
  }
}

// CR-01: set process.exitCode instead of calling process.exit(code). When stdout
// is a pipe (the package's core consumption mode — `platform-map --json | jq`, or
// Dark Factory/Spec Engine spawning it), writes are async+buffered; process.exit()
// discards the buffered tail once output exceeds the ~64KB pipe buffer, silently
// truncating the JSON payload with a success code. Setting exitCode lets the event
// loop drain stdout/stderr fully, then exits with the same code exitFor/runInit
// computed. Never call process.exit anywhere in this file.
// WR-01: main() deliberately re-throws anything that is not RootNotFoundError/
// MalformedConfigError ("surface it, never mask as 0"). Without a rejection
// handler that re-throw becomes an unhandled promise rejection whose exit code
// and output are runtime-dependent (Node vs Bun, both required per D5). This is
// the last-resort net for truly unexpected errors: one clean line to stderr
// (stdout stays clean for --json consumers) and a defined exit code 1 — set via
// exitCode (CR-01), never process.exit.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    // One clean line to stderr (message only, never a raw stack trace), stdout
    // stays clean for --json consumers, exit 1.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`platform-map: internal error: ${message}\n`);
    process.exitCode = 1;
  },
);
