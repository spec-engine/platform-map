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

import { graph } from "../graph.js";
import type {
  Detection,
  Edge,
  MemberMarker,
  PlatformDefinition,
  PlatformMap,
  PlatformMapConfig,
  Unit,
} from "../types.js";
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
  /** WR-03: containment boundary for platform resolution, threaded to
   *  MapOptions.boundary. Unset → the library default (os.homedir()). */
  boundary?: string;
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
 *
 * WR-02: a bare `--` is the POSIX end-of-options separator — every token AFTER it
 * is a positional (subcommand-or-dir), never a flag. This is what makes a
 * directory whose name legitimately starts with `-` reachable
 * (`platform-map -- -weird` targets the dir `-weird`). Unknown-flag rejection
 * still applies to real flags that appear BEFORE the `--`.
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
  let optsEnded = false;
  let pendingBoundary = false;
  for (const tok of argv) {
    // A pending --boundary consumes the NEXT token verbatim as its value
    // (even a dash-prefixed path) — checked before any flag parsing.
    if (pendingBoundary) {
      a.boundary = tok;
      pendingBoundary = false;
      continue;
    }
    if (!optsEnded) {
      if (tok === "--") {
        optsEnded = true;
        continue;
      }
      switch (tok) {
        case "--boundary":
          pendingBoundary = true;
          continue;
        case "--json":
          a.json = true;
          continue;
        case "--dot":
          a.dot = true;
          continue;
        case "--yes":
        case "-y":
          a.yes = true;
          continue;
        case "--help":
        case "-h":
          a.help = true;
          continue;
        case "--version":
        case "-V":
          a.version = true;
          continue;
      }
      if (tok.startsWith("-")) {
        a.error = `unknown flag: ${tok}`;
        return a;
      }
    }
    // Positional handling (subcommand-or-dir): reached for every non-flag token
    // before `--`, and for EVERY token after `--` (so dash-prefixed dirs land here).
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
  if (pendingBoundary) {
    a.error = "missing value for --boundary";
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

/**
 * The `graph` projection shape (CLI-03, Open Q1): a fully JSON-serializable
 * object — never the PlatformGraph itself (its toDepGraph() returns Map/Set,
 * which JSON.stringify would silently drop). `edges` is serialize(pm).edges
 * verbatim; roots/leaves/cycles are the already-sorted graph(pm) views.
 */
export interface GraphProjection {
  nodes: string[];
  edges: Edge[];
  roots: string[];
  leaves: string[];
  cycles: string[][];
}

/**
 * Minimal Graphviz DOT for `graph --dot` (CLI-03). Renders from serialize(pm)'s
 * (from,to)-sorted edge set — the CLI never sorts. Endpoint names are quoted via
 * JSON.stringify (correct escaping, no DOT-grammar injection; T-04-05). A
 * zero-edge map yields an empty-bodied `digraph platform {\n}`. Zero I/O, no
 * trailing newline (the dispatcher appends exactly one).
 */
export function toDot(pm: PlatformMap): string {
  const s = serialize(pm);
  const lines = ["digraph platform {"];
  for (const e of s.edges) {
    lines.push(`  ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)};`);
  }
  lines.push("}");
  return lines.join("\n");
}

/**
 * Builds the deterministic `graph` projection (CLI-03). `nodes` is the flattened,
 * lexically-sorted list of every unit name (recursing units[]); `edges` reuses
 * serialize(pm).edges; roots/leaves/cycles reuse the already-sorted graph(pm)
 * views — the CLI never traverses edges or re-sorts them (CLI-06 / determinism).
 * Fully JSON-serializable: only string[]/Edge[]/string[][], never Map/Set.
 */
export function graphProjection(pm: PlatformMap): GraphProjection {
  const s = serialize(pm);
  const g = graph(s);
  const nodes: string[] = [];
  const collect = (list: Unit[]): void => {
    for (const u of list) {
      nodes.push(u.name);
      if (u.units.length > 0) collect(u.units);
    }
  };
  collect(s.units);
  nodes.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    nodes,
    edges: s.edges,
    roots: g.roots(),
    leaves: g.leaves(),
    cycles: g.cycles(),
  };
}

/**
 * The honest, minimal `platform-map.json` proposal for `init` (CLI-04, Open Q2).
 * PURE — zero I/O; the actual write lives in bin/platform-map.ts (SEC-05). Always
 * carries `name`. For `multi-repo`, adds `units[]` distilled from the detected
 * siblings — carrying ONLY name/path/ref (never the internal hasDfPointer/conflict
 * facts), omitting `ref` when null. For single-repo/monorepo the object is `{ name }`
 * alone: the workspace adapter re-discovers members, and v1 init writes from
 * detection only (no adopt-existing). The result is a valid PlatformMapConfig (every
 * field optional, D8) and fully JSON-serializable — proven to round-trip via map().
 */
export function buildProposal(
  detection: Detection,
  name: string,
): PlatformMapConfig {
  if (detection.mode === "multi-repo") {
    const units = (detection.siblings ?? []).map((s) => ({
      name: s.name,
      path: s.path,
      ...(s.ref != null ? { ref: s.ref } : {}),
    }));
    return { name, units };
  }
  return { name };
}

/** One file in the platform-init write plan (D-07): a root-relative POSIX
 *  path plus its JSON content (object form — the dispatcher stringifies and
 *  owns the write). */
export interface PlatformInitFile {
  path: string;
  content: PlatformDefinition | MemberMarker;
}

/**
 * The platform-bootstrap init plan (D-07/RED-97). PURE — zero I/O; the actual
 * per-file existence gates and writes live in bin/platform-map.ts (SEC-05).
 * Takes the platform name and the child-repo sibling list (from detect() with
 * scanRoot ".") and returns the ordered file plan: FIRST the checked-in
 * definition (name + members, member `path` omitted when it equals the name —
 * the IP-1 child-dir convention), THEN one committed marker per member with
 * `platform` + an explicit root ".." (D-03: identity + root hint only — no
 * sibling lists, no machine paths). Deterministic ordering: members arrive
 * sorted by name from scanSiblings (sort-at-construction) — this function
 * relies on that and deliberately does not re-sort (serialize.ts stays the
 * library's sole sort site; scanSiblings is the scan-side precedent).
 */
export function buildPlatformInit(
  name: string,
  children: NonNullable<Detection["siblings"]>,
): PlatformInitFile[] {
  const members: PlatformDefinition["members"] = children.map((c) =>
    c.path === c.name ? { name: c.name } : { name: c.name, path: c.path },
  );
  const plan: PlatformInitFile[] = [
    { path: "platform-map.json", content: { name, members } },
  ];
  for (const c of children) {
    plan.push({
      path: `${c.path}/platform-map.json`,
      content: { platform: name, root: ".." },
    });
  }
  return plan;
}

/**
 * Parses an interactive y/N answer (CLI-04). Only `y`/`yes` (any case, surrounding
 * whitespace tolerated) affirms; empty input and anything else declines — the
 * conservative default for a write-gating prompt.
 */
export function parseYesNo(s: string): boolean {
  return /^y(es)?$/i.test(s.trim());
}

/** Short usage/synopsis line (to stderr on a usage error). */
export function usage(err?: string): string {
  const prefix = err ? `platform-map: ${err}\n` : "";
  return `${prefix}usage: platform-map [--json] [--boundary <dir>] [dir]\n       platform-map [detect|graph|init] [dir] [--dot] [--yes] [--boundary <dir>]\n       platform-map --help | --version\n`;
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
    "  --json            emit JSON instead of the human tree",
    "  --dot             emit Graphviz DOT (graph only)",
    "  --yes, -y         skip the confirmation prompt (init only)",
    "  --boundary <dir>  containment boundary for upward platform resolution",
    "                    and marker/override following (default: the home",
    "                    directory); a definition at the invoked dir itself",
    "                    is always honored",
    "  --help, -h        show this help and exit 0",
    "  --version, -V     print the version and exit 0",
    "",
  ].join("\n");
}
