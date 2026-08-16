// The CLI's pure presentation and grammar seam: every function is a pure,
// zero-I/O transform of argv or a PlatformMap; the dispatcher in
// bin/platform-map.ts owns all stream writes and the single library call.
// Rendering starts from serialize(pm), so ordering is never re-derived here.

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

/** Flat, fully-resolved view of the command line. */
export interface Args {
  command: Command;
  dir: string; // default "."
  json: boolean;
  dot: boolean;
  yes: boolean;
  help: boolean;
  version: boolean;
  /** Containment boundary for platform resolution (MapOptions.boundary).
   *  Unset means the library default, os.homedir(). */
  boundary?: string;
  /** Set → dispatcher prints usage() to stderr and exits 1. */
  error?: string;
}

const SUBCOMMANDS = new Set<Command>(["detect", "graph", "init"]);

/**
 * Hand-rolled zero-dep parser. A bare token in SUBCOMMANDS claims `command`
 * only before options end and before a positional is seen; the next bare
 * token is `dir`; any later token is a usage error, so a subcommand token
 * after the dir never reorders the command. An unknown `-` flag sets
 * `error`; `--dot`/`--yes` on a non-owning command are accepted and ignored.
 * A bare `--` ends options (POSIX), making a directory whose name starts
 * with `-` or matches a subcommand reachable as a positional.
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
    // A pending --boundary consumes the next token verbatim, even dash-prefixed.
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
    const mayClaim = !optsEnded && !sawDir && a.command === "map";
    if (mayClaim && SUBCOMMANDS.has(tok as Command)) {
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

/** CLI-01: deterministic box-drawing tree from serialize(pm)'s order. No
 *  ANSI, no trailing newline (the dispatcher appends exactly one). */
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

/** CLI-05: exit 2 when any diagnostic has severity "error", else 0. */
export function exitFor(pm: PlatformMap): number {
  return pm.diagnostics.some((d) => d.severity === "error") ? 2 : 0;
}

/** Fully JSON-serializable `graph` projection; never the PlatformGraph
 *  itself (its toDepGraph() returns Map/Set, which JSON.stringify drops). */
export interface GraphProjection {
  nodes: string[];
  edges: Edge[];
  roots: string[];
  leaves: string[];
  cycles: string[][];
}

/** CLI-03: Graphviz DOT for `graph --dot` over serialize(pm)'s sorted edges.
 *  Endpoints are quoted via JSON.stringify: correct escaping, no DOT-grammar
 *  injection. A zero-edge map yields an empty-bodied digraph. */
export function toDot(pm: PlatformMap): string {
  const s = serialize(pm);
  const lines = ["digraph platform {"];
  for (const e of s.edges) {
    lines.push(`  ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)};`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** `nodes` is the flattened, lexically sorted list of every unit name;
 *  edges/roots/leaves/cycles reuse the already-sorted library views. */
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

/** CLI-04: the minimal `platform-map.json` proposal for `init`; pure, the
 *  write lives in bin/platform-map.ts. Multi-repo adds `units[]` carrying
 *  only name/path/ref (`ref` omitted when null); single-repo/monorepo stays
 *  `{ name }`, since the workspace adapter re-discovers members. */
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

/** One file in the platform-init write plan: a root-relative POSIX path plus
 *  its JSON content; the dispatcher stringifies and owns the write. */
export interface PlatformInitFile {
  path: string;
  content: PlatformDefinition | MemberMarker;
}

/** The platform-bootstrap init plan; pure, gates and writes live in
 *  bin/platform-map.ts. First the checked-in definition (member `path`
 *  omitted when equal to the name), then one committed marker per member:
 *  `platform` plus root ".." only, identity and a root hint, never sibling
 *  lists or machine paths. Members arrive name-sorted from scanSiblings and
 *  are deliberately not re-sorted here. */
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

/** Only `y`/`yes` (any case, trimmed) affirms; anything else declines, the
 *  conservative default for a write-gating prompt. */
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
