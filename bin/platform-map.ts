#!/usr/bin/env node
// The CLI: parse arguments, call one library function, print, set the exit
// code. Prompts and diagnostics go to stderr so --json output stays clean.

import * as readline from "node:readline/promises";
import {
  applyInit,
  applyLink,
  check,
  DirectoryNotFoundError,
  formatDiagnostics,
  locate,
  map,
  planInit,
  planLink,
  render,
  toJSON,
  toMermaid,
} from "../src/index.ts";
import type { Options } from "../src/types.ts";

declare const __CLI_VERSION__: string;

const HELP = `platform-map: document which repos make up a platform, and see what is in them

usage:
  platform-map [dir]              print the map (tree)
  platform-map --json [dir]       print the map as deterministic JSON
  platform-map --mermaid [dir]    print the map as a Mermaid flowchart
  platform-map --paths [dir]      include where each repo is on this machine
  platform-map init [dir]         discover repos here and declare them as members
  platform-map link [dir]         record where this checkout lives (non-conventional layouts)
  platform-map check [dir]        exit 1 if the files and the disk disagree

flags:
  --yes, -y          answer yes to every prompt
  --dry-run          init: print the plan, write nothing
  --root <dir>       link: where the platform directory is
  --config <file>    per-user file (default: $PLATFORM_MAP_CONFIG or ~/.config/platform-map/platforms.json)
  --ignore <name>    skip a directory during discovery (repeatable; init remembers it in the platform file)
  --help, -h         show this help
  --version, -V      print the version
`;

interface Args {
  command: "map" | "init" | "link" | "check";
  dir: string;
  json: boolean;
  mermaid: boolean;
  paths: boolean;
  yes: boolean;
  dryRun: boolean;
  help: boolean;
  version: boolean;
  options: Options;
  error?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: "map",
    dir: ".",
    json: false,
    mermaid: false,
    paths: false,
    yes: false,
    dryRun: false,
    help: false,
    version: false,
    options: {},
  };
  let sawDir = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] ?? "";
    const next = (): string | undefined => argv[++i];
    if (t === "--json") a.json = true;
    else if (t === "--mermaid") a.mermaid = true;
    else if (t === "--paths") a.paths = true;
    else if (t === "--yes" || t === "-y") a.yes = true;
    else if (t === "--dry-run") a.dryRun = true;
    else if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--version" || t === "-V") a.version = true;
    else if (t === "--root") a.options.root = next();
    else if (t === "--config") a.options.userConfigPath = next();
    else if (t === "--ignore")
      a.options.ignore = [...(a.options.ignore ?? []), next() ?? ""];
    else if (t.startsWith("-")) a.error = `unknown flag: ${t}`;
    else if (
      !sawDir &&
      (t === "init" || t === "link" || t === "check") &&
      a.command === "map"
    )
      a.command = t;
    else if (!sawDir) {
      a.dir = t;
      sawDir = true;
    } else a.error = `unexpected argument: ${t}`;
  }
  return a;
}

async function ask(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "platform-map: not a terminal; pass --yes to confirm\n",
    );
    return false;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === "" || answer === "y" || answer === "yes";
}

async function runInit(a: Args): Promise<number> {
  const plan = planInit(a.dir, a.options);
  if (plan.problem !== undefined) {
    process.stderr.write(`platform-map: ${plan.problem}\n`);
    return 1;
  }
  const unlisted = plan.candidates.filter((c) => !c.listed);
  const foreign = unlisted.filter(
    (c) => c.marker !== undefined && c.marker !== plan.platformName,
  );
  const eligible = unlisted.filter((c) => !foreign.includes(c));

  process.stderr.write(`Platform "${plan.platformName}" at ${plan.root}\n`);
  if (plan.members.length > 0)
    process.stderr.write(`Already members: ${plan.members.join(", ")}\n`);
  for (const c of foreign)
    process.stderr.write(
      `Skipping ${c.name}: its marker names platform "${c.marker}"\n`,
    );
  if (eligible.length === 0 && Object.keys(plan.writes).length <= 1) {
    process.stderr.write("Nothing new to declare.\n");
    return 0;
  }

  if (a.dryRun) {
    process.stdout.write(`${JSON.stringify(plan.writes, null, 2)}\n`);
    return 0;
  }

  const include: string[] = [];
  for (const c of eligible) {
    const kind = c.hasGit ? "git repo" : "package.json, no .git";
    const prompt = `Include ${c.name} (${kind}) in ${plan.platformName}? [Y/n] `;
    if (await ask(prompt, a.yes)) include.push(c.name);
    else if (!a.yes && !process.stdin.isTTY) return 1;
  }
  const result = applyInit(plan, include, a.options);
  for (const p of result.written) process.stdout.write(`wrote ${p}\n`);
  for (const p of result.skipped) process.stderr.write(`kept  ${p}\n`);
  return 0;
}

async function runLink(a: Args): Promise<number> {
  const plan = planLink(a.dir, a.options);
  if (plan.root === null) {
    process.stderr.write(`platform-map: ${plan.problem ?? "cannot link"}\n`);
    return 1;
  }
  const what = Object.entries(plan.members)
    .map(([m, p]) => `${m} -> ${p}`)
    .join(", ");
  const line = `platform "${plan.platformName}" at ${plan.root}${what ? `; ${what}` : ""}`;
  if (!(await ask(`Record ${line} in ${plan.userFile}? [Y/n] `, a.yes)))
    return 1;
  const result = applyLink(plan, a.options);
  for (const p of result.written) process.stdout.write(`wrote ${p}\n`);
  return 0;
}

function runMap(a: Args): number {
  const pm = map(a.dir, a.options);
  if (a.json) {
    if (a.paths) {
      const withPaths = { ...pm, paths: locate(a.dir, a.options) };
      process.stdout.write(`${JSON.stringify(withPaths, null, 2)}\n`);
    } else process.stdout.write(toJSON(pm));
  } else if (a.mermaid) {
    process.stdout.write(toMermaid(pm));
  } else {
    process.stdout.write(
      render(pm, a.paths ? locate(a.dir, a.options) : undefined),
    );
    const diag = formatDiagnostics(pm);
    if (diag) process.stderr.write(`\n${diag}`);
  }
  return pm.diagnostics.some((d) => d.severity === "error") ? 1 : 0;
}

function runCheck(a: Args): number {
  const result = check(a.dir, a.options);
  for (const d of result.problems)
    process.stderr.write(`${d.severity}  ${d.code}  ${d.message}\n`);
  if (result.ok) process.stderr.write("platform-map: ok\n");
  return result.ok ? 0 : 1;
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  if (a.error) {
    process.stderr.write(`platform-map: ${a.error}\n${HELP}`);
    return 1;
  }
  if (a.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (a.version) {
    process.stdout.write(`${__CLI_VERSION__}\n`);
    return 0;
  }
  try {
    if (a.command === "init") return await runInit(a);
    if (a.command === "link") return await runLink(a);
    if (a.command === "check") return runCheck(a);
    return runMap(a);
  } catch (e) {
    if (e instanceof DirectoryNotFoundError) {
      process.stderr.write(`platform-map: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

// exitCode (not process.exit) so piped stdout drains fully before exiting.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(
      `platform-map: internal error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exitCode = 1;
  },
);
