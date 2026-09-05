#!/usr/bin/env node
// CLI entry / dispatcher: parse argv, one library call, stream-route, exit.
// Pure logic lives in src/internal/cli-render.ts; this file owns the stream
// writes and the error-to-exit-1 mapping. Stream contract: human mode prints
// the tree to stdout and diagnostics to stderr; --json prints to stdout only.
// Exit codes: 2 on error-severity diagnostics (exitFor), 1 on usage/root
// errors. The version is build-time-injected, never read from package.json.

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

// Build-time-injected version constant; declared so tsc can type-check it.
declare const __CLI_VERSION__: string;

function mapOptions(boundary: string | undefined): MapOptions {
  return boundary === undefined ? {} : { boundary };
}

/** One diagnostic message per line → stderr (human mode only; --json embeds them). */
function writeDiagnostics(pm: PlatformMap): void {
  for (const d of pm.diagnostics) {
    process.stderr.write(`${d.message}\n`);
  }
}

// Shared confirm gate for init writes: --yes pre-confirms; a non-TTY stdin
// without --yes refuses (exit 1, never hang a CI job on stdin); a typed `N`
// declines cleanly (exit 0). Returns null when confirmed, else the exit code.
// Prompt and refuse/decline lines go to stderr so stdout stays the proposal.
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

// Platform-bootstrap init: a checked-in definition at the root plus one
// committed marker per member; an existing member marker is skipped with a
// stderr note, never overwritten. Plan JSON to stdout keyed by root-relative
// path; listing and prompts to stderr. Every write target is the fixed
// basename platform-map.json (the user controls directories, never
// filenames); platform-map.local.json is never written.
async function runPlatformInit(
  dir: string,
  yes: boolean,
  detection: Detection,
): Promise<number> {
  const name = path.basename(path.resolve(dir));
  const plan = buildPlatformInit(name, detection.siblings ?? []).filter((f) => {
    if (f.path === "platform-map.json") return true; // gated whole-init in runInit
    // Never write through a symlinked member dir (the marker would land
    // outside the targeted tree): lstat the parent, no follow; skip with a note.
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
    `Write ${plan.length} file${plan.length === 1 ? "" : "s"}? [y/N]`,
  );
  if (gate !== null) return gate;
  for (const f of plan) {
    // The plan-time existsSync gate is advisory (a file can appear during the
    // prompt); the exclusive "wx" flag makes refuse-if-exists atomic. Root-file
    // EEXIST refuses the whole init; member-marker EEXIST is a per-file skip.
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

// init is the package's only write path, gated before any write by
// refuse-if-exists (never clobber an authored file), non-TTY without --yes,
// and a typed `N`. Proposal to stdout; prompt and status lines to stderr.
async function runInit(dir: string, yes: boolean): Promise<number> {
  const configPath = path.join(dir, "platform-map.json");
  if (fs.existsSync(configPath)) {
    process.stderr.write(
      "platform-map: platform-map.json already exists; refusing to overwrite\n",
    );
    return 1;
  }
  const detection = detect(dir);
  if (detection.mode !== "monorepo") {
    // No workspace manifest: probe the dir's own children for .git repos; a
    // multi-repo result means this dir is a platform root to bootstrap.
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
  // Exclusive flag: a file created during the prompt window is never clobbered.
  try {
    fs.writeFileSync(configPath, `${text}\n`, { flag: "wx" });
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
    a.dir = path.resolve(a.dir);
    switch (a.command) {
      case "detect": {
        // detect() carries no diagnostics: JSON to stdout, nothing to stderr.
        process.stdout.write(`${JSON.stringify(detect(a.dir), null, 2)}\n`);
        return 0;
      }
      case "graph": {
        const pm = await map(a.dir, mapOptions(a.boundary));
        process.stdout.write(
          `${a.dot ? toDot(pm) : JSON.stringify(graphProjection(pm), null, 2)}\n`,
        );
        writeDiagnostics(pm);
        return exitFor(pm);
      }
      case "init": {
        return await runInit(a.dir, a.yes);
      }
      default: {
        const pm = await map(a.dir, mapOptions(a.boundary));
        if (a.json) {
          // --json: stdout only, nothing to stderr.
          process.stdout.write(`${toJSON(pm)}\n`);
        } else {
          // Human mode: tree to stdout, diagnostics to stderr.
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
    throw e; // truly unexpected: surface it, never mask as 0
  }
}

// Set process.exitCode instead of calling process.exit(): with stdout piped
// (`platform-map --json | jq`, or a parent process spawning it) process.exit() would
// truncate JSON beyond the ~64KB pipe buffer while still exiting 0; exitCode
// lets the event loop drain both streams first. The rejection handler is the
// last-resort net for main()'s re-thrown unexpected errors: one message-only
// line to stderr, stdout stays clean for --json consumers, exit 1.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`platform-map: internal error: ${message}\n`);
    process.exitCode = 1;
  },
);
