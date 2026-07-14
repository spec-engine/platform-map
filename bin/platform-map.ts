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
import type { PlatformMap } from "../src/types.js";

// Build-time-injected version constant (tsdown `define`); declared so
// `tsc --noEmit` type-checks without a runtime package.json read (D-04).
declare const __CLI_VERSION__: string;

/** One diagnostic message per line → stderr (human mode only; --json embeds them). */
function writeDiagnostics(pm: PlatformMap): void {
  for (const d of pm.diagnostics) {
    process.stderr.write(`${d.message}\n`);
  }
}

// init — the ONE and ONLY write path in the entire package (SEC-05). Gated three
// ways before the single write: refuse-if-exists (never clobber an authored file),
// non-TTY-without-`--yes` (never hang a CI job on stdin), and a typed `N` (clean
// decline, exit 0). The proposal prints to STDOUT (machine-consumable); the readline
// prompt and every status/refuse line go to STDERR so stdout stays clean. The write
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
  const text = JSON.stringify(
    buildProposal(detection, path.basename(path.resolve(dir))),
    null,
    2,
  );
  process.stdout.write(`${text}\n`);
  if (!yes) {
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
    const answer = await rl.question("Write platform-map.json? [y/N] ");
    rl.close();
    if (!parseYesNo(answer)) {
      process.stderr.write("platform-map: aborted\n");
      return 0; // typed N is a clean decline, not an error
    }
  }
  fs.writeFileSync(configPath, `${text}\n`); // THE ONE WRITE (SEC-05)
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
        const pm = await map(a.dir);
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
        const pm = await map(a.dir);
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
main().then((code) => {
  process.exitCode = code;
});
