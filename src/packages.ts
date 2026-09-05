// describeRepo(): the facts about one repository: single repo or monorepo,
// its package name and package manager, its workspace packages, and the
// dependency names each package.json declares. `dependsOn` is computed later
// by map(), once every package name in the platform is known.

import * as path from "node:path";
import { probeWorkspace } from "./detect.ts";
import { exists, readJsonObject } from "./files.ts";
import { matchGlob } from "./internal/glob.ts";
import { walk } from "./internal/walk.ts";
import type { Diagnostic, Repo } from "./types.ts";

const MAX_DEPTH = 16;
const MAX_ENTRIES = 10000;
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

const LOCKFILES: Array<[string, NonNullable<Repo["packageManager"]>]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

export interface PackageFacts {
  path: string;
  packageName?: string;
  deps: string[];
}

export interface RepoFacts {
  mode: "single-repo" | "monorepo";
  packageName?: string;
  packageManager?: Repo["packageManager"];
  deps: string[];
  packages: PackageFacts[];
  diagnostics: Diagnostic[];
}

/** Reads name and declared dependency names from a package.json. */
function readPackage(
  dir: string,
  subject: string,
  diagnostics: Diagnostic[],
): { packageName?: string; deps: string[] } {
  const read = readJsonObject(path.join(dir, "package.json"));
  if (read === null) return { deps: [] };
  if (!read.ok) {
    diagnostics.push({
      code: "MALFORMED_FILE",
      severity: "warning",
      subject,
      message: `${subject}/package.json: ${read.reason}`,
    });
    return { deps: [] };
  }
  const pkg = read.value;
  const deps = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const block = pkg[field];
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      for (const name of Object.keys(block as object)) deps.add(name);
    }
  }
  const out: { packageName?: string; deps: string[] } = {
    deps: [...deps].sort(),
  };
  if (typeof pkg.name === "string" && NPM_NAME.test(pkg.name))
    out.packageName = pkg.name;
  return out;
}

function packageManager(dir: string): Repo["packageManager"] | undefined {
  for (const [file, manager] of LOCKFILES) {
    if (exists(path.join(dir, file))) return manager;
  }
  return undefined;
}

export function describeRepo(dir: string, subject: string): RepoFacts {
  const diagnostics: Diagnostic[] = [];
  const root = readPackage(dir, subject, diagnostics);
  const facts: RepoFacts = {
    mode: "single-repo",
    deps: root.deps,
    packages: [],
    diagnostics,
  };
  if (root.packageName !== undefined) facts.packageName = root.packageName;
  const pm = packageManager(dir);
  if (pm !== undefined) facts.packageManager = pm;

  const ws = probeWorkspace(dir);
  if (ws === null) return facts;

  facts.mode = "monorepo";
  for (const d of ws.diagnostics)
    diagnostics.push({ ...d, subject: `${subject}/${d.subject}` });

  const walked = walk(dir, { maxDepth: MAX_DEPTH, maxEntries: MAX_ENTRIES });
  for (const d of walked.diagnostics)
    diagnostics.push({ ...d, subject: `${subject}/${d.subject}` });
  const matched = matchGlob(ws.globs, walked.entries);
  for (const d of matched.diagnostics)
    diagnostics.push({ ...d, subject: `${subject}: ${d.subject}` });

  for (const rel of matched.matched) {
    if (rel.split("/").includes("..")) continue;
    const abs = path.join(dir, rel);
    if (!exists(path.join(abs, "package.json"))) continue;
    const pkg = readPackage(abs, `${subject}/${rel}`, diagnostics);
    const entry: PackageFacts = { path: rel, deps: pkg.deps };
    if (pkg.packageName !== undefined) entry.packageName = pkg.packageName;
    facts.packages.push(entry);
  }
  return facts;
}
