#!/usr/bin/env node
// CLI entry / dispatcher (CLI-01/02/05/06). A thin (~100-line) ESM-only entry:
// parse argv -> one library call -> stream-route -> exit. All pure logic lives
// in src/internal/cli-render.ts; this file owns only the stream writes, the
// single map() call, and the error->exit-1 mapping.
//
// Uses no build-relative path globals (D-04) — resolution is always relative
// to the caller-supplied `dir`, which map() path.resolves internally; the version
// is injected at build time (__CLI_VERSION__), never read from package.json here.

import {
  MalformedConfigError,
  map,
  RootNotFoundError,
  toJSON,
} from "../src/index.js";
import {
  exitFor,
  help,
  parseArgs,
  renderTree,
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
    // This slice implements the default (map) path only; detect/graph/init land
    // in later plans as their own switch arms.
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
  } catch (e) {
    if (e instanceof RootNotFoundError || e instanceof MalformedConfigError) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    throw e; // truly unexpected — surface it, never mask as 0
  }
}

main().then((code) => {
  process.exit(code);
});
