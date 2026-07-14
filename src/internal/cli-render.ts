// The CLI's pure presentation + grammar seam (CLI-01/02/05/06). Zero I/O and no
// build-relative path globals (D-04): every function here is a pure transform of
// argv or a PlatformMap into a string/struct/number — the dispatcher in
// bin/platform-map.ts owns all stream writes and the single library call.
//
// Determinism discipline (mirrors serialize.ts/toJSON): renderTree calls
// serialize(pm) FIRST so the CLI never re-sorts — the library's sorted view is
// the single source of order (DETR-02). No ANSI, no absolute paths (Unit.name is
// platform-relative by contract, MODEL-05).
//
// Auto-built to dist/internal/cli-render.mjs by tsdown entry #3
// (`src/internal/*.ts`) — no tsdown.config.ts change is needed for THIS module.

import type { PlatformMap, Unit } from "../types.js";
import { serialize } from "./serialize.js";

/** The four dispatchable commands. `map` is the default (no subcommand token). */
export type Command = "map" | "detect" | "graph" | "init";

/** Flat, fully-resolved view of the command line (Pattern 1). */
export interface Args {
  command: Command;
  dir: string; // default "."
  json: boolean;
  dot: boolean;
  yes: boolean;
  help: boolean;
  version: boolean;
  /** Set → dispatcher prints usage() to stderr and exits 1. */
  error?: string;
}

const SUBCOMMANDS = new Set<Command>(["detect", "graph", "init"]);

/**
 * Hand-rolled, zero-dep arg parser (no commander/yargs). First bare token in the
 * SUBCOMMANDS set claims `command`; the first other bare token is `dir` (a second
 * bare token is a usage error). Any unrecognized `-`-prefixed token sets `error`
 * and returns immediately. `--dot`/`--yes` handed to a non-owning command are
 * accepted-and-ignored, not a usage error (they are gated by command at dispatch).
 */
export function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: "map",
    dir: ".",
    json: false,
    dot: false,
    yes: false,
    help: false,
    version: false,
  };
  let sawDir = false;
  for (const tok of argv) {
    switch (tok) {
      case "--json":
        a.json = true;
        break;
      case "--dot":
        a.dot = true;
        break;
      case "--yes":
      case "-y":
        a.yes = true;
        break;
      case "--help":
      case "-h":
        a.help = true;
        break;
      case "--version":
      case "-V":
        a.version = true;
        break;
      default:
        if (tok.startsWith("-")) {
          a.error = `unknown flag: ${tok}`;
          return a;
        }
        if (a.command === "map" && SUBCOMMANDS.has(tok as Command)) {
          a.command = tok as Command;
        } else if (!sawDir) {
          a.dir = tok;
          sawDir = true;
        } else {
          a.error = `unexpected argument: ${tok}`;
          return a;
        }
    }
  }
  return a;
}

/**
 * Deterministic Unicode box-drawing topology tree (CLI-01). Renders from
 * serialize(pm) first (belt-and-suspenders — the CLI never sorts). Header line is
 * `name (mode)`; each unit line is `name [mode, role]`; children recurse under
 * `├─`/`└─` branch chars with a `│` vertical continuation. No ANSI, no trailing
 * newline (the dispatcher appends exactly one), no absolute paths.
 */
export function renderTree(pm: PlatformMap): string {
  const sorted = serialize(pm);
  const lines: string[] = [`${sorted.name} (${sorted.mode})`];
  const walk = (u: Unit, prefix: string, last: boolean): void => {
    lines.push(
      `${prefix}${last ? "└─ " : "├─ "}${u.name} [${u.mode}, ${u.role}]`,
    );
    const childPrefix = prefix + (last ? "   " : "│  ");
    u.units.forEach((c, i) => {
      walk(c, childPrefix, i === u.units.length - 1);
    });
  };
  sorted.units.forEach((u, i) => {
    walk(u, "", i === sorted.units.length - 1);
  });
  return lines.join("\n");
}

/**
 * The exit-code gate (CLI-05): 2 when any diagnostic is severity "error", else 0.
 * No real directory tree emits "error" today (every library emitter is
 * "warning"/"info"), so this gate is proven white-box on a synthetic map — but it
 * MUST be correct for the day a producer emits "error" and for consumers
 * persisting maps.
 */
export function exitFor(pm: PlatformMap): number {
  return pm.diagnostics.some((d) => d.severity === "error") ? 2 : 0;
}

/** Short usage/synopsis line (to stderr on a usage error). */
export function usage(err?: string): string {
  const prefix = err ? `platform-map: ${err}\n` : "";
  return `${prefix}usage: platform-map [--json] [dir]\n       platform-map [detect|graph|init] [dir] [--dot] [--yes]\n       platform-map --help | --version\n`;
}

/** The `--help` text: default command + subcommands + flags. */
export function help(): string {
  return [
    "platform-map — deterministic platform topology map",
    "",
    "usage:",
    "  platform-map [dir]            print the topology tree (default)",
    "  platform-map --json [dir]     print the deterministic PlatformMap JSON",
    "  platform-map detect [dir]     print raw detect() classification (JSON)",
    "  platform-map graph [dir]      print the dependency graph (JSON, or --dot)",
    "  platform-map init [dir]       write a proposed platform-map.json",
    "",
    "flags:",
    "  --json        emit JSON instead of the human tree",
    "  --dot         emit Graphviz DOT (graph only)",
    "  --yes, -y     skip the confirmation prompt (init only)",
    "  --help, -h    show this help and exit 0",
    "  --version, -V print the version and exit 0",
    "",
  ].join("\n");
}
